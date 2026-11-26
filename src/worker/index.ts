import { Hono } from "hono";
import { cors } from "hono/cors";
import { eq, and, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createAuth } from "./auth";
import type { Env } from "./env";
import { recordings, recordingChunks, schema } from "./db/schema";

const app = new Hono<{ Bindings: Env }>();
app.use(
  "/api/*",
  cors({
    origin: (origin) => origin,
    credentials: true,
    allowHeaders: ["Content-Type"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  }),
);
app.on(["GET", "POST"], "/api/auth/*", (c) =>
  createAuth(c.env).handler(c.req.raw),
);

const dbFor = (env: Env) => drizzle(env.DB, { schema });
async function currentUser(c: any) {
  const session = await createAuth(c.env).api.getSession({
    headers: c.req.raw.headers,
  });
  return session?.user ?? null;
}

app.get("/api/me", async (c) => c.json({ user: await currentUser(c) }));

app.get("/api/recordings", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const rows = await dbFor(c.env)
    .select({
      id: recordings.id,
      title: recordings.title,
      duration_ms: recordings.durationMs,
      transcript: recordings.transcript,
      created_at: recordings.createdAt,
      status: recordings.status,
    })
    .from(recordings)
    .where(eq(recordings.userId, user.id))
    .orderBy(desc(recordings.createdAt))
    .limit(100);
  return c.json({ recordings: rows });
});

// Plain HTTP health check. Do not probe /api/live with fetch(): that route
// correctly returns 426 unless the request includes an Upgrade: websocket header.
app.get("/api/health", (c) =>
  c.json({ ok: true, service: "voicetrail-worker" }),
);

// Create the D1 metadata row before opening the audio WebSocket.
app.post("/api/recordings/start", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json<{
    id?: string;
    title?: string;
    mimeType?: string;
  }>();
  const id = body.id || crypto.randomUUID();
  const mimeType = body.mimeType || "audio/webm;codecs=opus";
  const audioKey = `users/${user.id}/recordings/${id}/audio.webm`;
  const transcriptKey = `users/${user.id}/recordings/${id}/transcript.txt`;
  await dbFor(c.env)
    .insert(recordings)
    .values({
      id,
      userId: user.id,
      title: (body.title || "Untitled recording").slice(0, 120),
      audioKey,
      transcriptKey,
      mimeType,
      status: "recording",
      transcript: "",
      durationMs: 0,
    });
  return c.json({ id });
});

// WebSocket receives each MediaRecorder timeslice immediately. Every binary frame is
// persisted as an R2 object + D1 chunk row, then Whisper output is pushed to the socket.
app.get("/api/live/:id", async (c) => {
  let user: any = null;
  try {
    user = await currentUser(c);
  } catch {
    /* auth misconfiguration: fall through to 401 */
  }
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
    return c.json(
      {
        error:
          "This endpoint only accepts WebSocket upgrades. If you see this in the browser, the proxy stripped the Upgrade header — use http://localhost:5173 (Vite) or check wrangler.toml run_worker_first.",
      },
      426,
    );
  const db = dbFor(c.env);
  const recordingId = c.req.param("id");
  const [recording] = await db
    .select()
    .from(recordings)
    .where(and(eq(recordings.id, recordingId), eq(recordings.userId, user.id)))
    .limit(1);
  if (!recording) return c.json({ error: "Recording not found" }, 404);

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  let transcript = recording.transcript || "";
  let nextIndex = 0;
  const audioParts: Uint8Array[] = [];
  let totalAudioBytes = 0;
  let busy = Promise.resolve();

  server.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      try {
        const message = JSON.parse(event.data);
        if (message.type === "finish") {
          const durationMs = Math.max(0, Number(message.durationMs || 0));
          busy = busy
            .then(async () => {
              try {
                await c.env.AUDIO_BUCKET.put(
                  recording.transcriptKey,
                  transcript,
                  {
                    httpMetadata: { contentType: "text/plain; charset=utf-8" },
                  },
                );
                await db
                  .update(recordings)
                  .set({ transcript, durationMs, status: "processing" })
                  .where(eq(recordings.id, recordingId));
              } catch (error) {
                server.send(
                  JSON.stringify({
                    type: "error",
                    error:
                      error instanceof Error
                        ? error.message
                        : "Could not finalize session",
                  }),
                );
              }
              // Always acknowledge so the client proceeds to upload the final audio blob.
              if (server.readyState === WebSocket.OPEN)
                server.send(JSON.stringify({ type: "finished", transcript }));
            })
            .catch(() => {
              if (server.readyState === WebSocket.OPEN)
                server.send(JSON.stringify({ type: "finished", transcript }));
            });
        }
      } catch {
        server.send(
          JSON.stringify({ type: "error", error: "Invalid control message" }),
        );
      }
      return;
    }
    const data =
      event.data instanceof ArrayBuffer
        ? event.data
        : event.data instanceof Blob
          ? event.data.arrayBuffer()
          : null;
    if (!data) return;
    busy = busy.then(async () => {
      try {
        const bytes =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(await data);
        if (!bytes.byteLength) return;
        const index = nextIndex++;
        const key = `users/${user.id}/recordings/${recordingId}/chunks/${String(index).padStart(6, "0")}.webm`;
        await c.env.AUDIO_BUCKET.put(key, bytes, {
          httpMetadata: { contentType: recording.mimeType || "audio/webm" },
        });
        const chunkId = crypto.randomUUID();
        await db.insert(recordingChunks).values({
          id: chunkId,
          recordingId,
          userId: user.id,
          chunkIndex: index,
          objectKey: key,
          mimeType: recording.mimeType || "audio/webm",
          sizeBytes: bytes.byteLength,
          transcript: "",
        });
        // MediaRecorder timeslices after the first may not contain a standalone WebM header.
        // Keep the stream prefix and transcribe the complete valid WebM accumulated so far.
        audioParts.push(bytes);
        totalAudioBytes += bytes.byteLength;
        if (totalAudioBytes > 24 * 1024 * 1024)
          throw new Error(
            "Live transcription reached the 24 MB session limit. Stop and save this recording, then start another.",
          );
        const completeAudio = new Uint8Array(totalAudioBytes);
        let offset = 0;
        for (const part of audioParts) {
          completeAudio.set(part, offset);
          offset += part.byteLength;
        }
        function bytesToBase64(bytes: Uint8Array): string {
          let binary = "";

          for (let i = 0; i < bytes.length; i += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          }

          return btoa(binary);
        }
        const audioBase64 = bytesToBase64(completeAudio);

        // console.log({
        //   model: "@cf/openai/whisper-large-v3-turbo",
        //   audioType: typeof audioBase64,
        //   audioLength: audioBase64.length,
        // });

        const result: any = await c.env.AI.run(
          "@cf/openai/whisper-large-v3-turbo",
          { audio: audioBase64 },
        );
        const text = String(result?.text || "").trim();
        if (text) transcript = text;
        await db
          .update(recordingChunks)
          .set({ transcript })
          .where(eq(recordingChunks.id, chunkId));
        await db
          .update(recordings)
          .set({ transcript })
          .where(eq(recordings.id, recordingId));
        await c.env.AUDIO_BUCKET.put(recording.transcriptKey, transcript, {
          httpMetadata: { contentType: "text/plain; charset=utf-8" },
        });
        server.send(
          JSON.stringify({ type: "transcript", index, text, transcript }),
        );
      } catch (error) {
        server.send(
          JSON.stringify({
            type: "error",
            error:
              error instanceof Error
                ? error.message
                : "Chunk transcription failed",
          }),
        );
      }
    });
  });
  server.addEventListener("close", () => {
    void busy;
  });
  return new Response(null, { status: 101, webSocket: client });
});

// Upload the browser's final contiguous MediaRecorder Blob for normal HTML audio playback.
app.post("/api/recordings/:id/finalize", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = dbFor(c.env);
  const id = c.req.param("id");
  const [row] = await db
    .select()
    .from(recordings)
    .where(and(eq(recordings.id, id), eq(recordings.userId, user.id)))
    .limit(1);
  if (!row) return c.json({ error: "Not found" }, 404);
  const form = await c.req.formData();
  const audio = form.get("audio");
  if (!(audio instanceof File) || audio.size === 0)
    return c.json({ error: "Final audio file is required" }, 400);
  if (audio.size > 150 * 1024 * 1024)
    return c.json({ error: "Audio exceeds 150 MB" }, 413);
  const title = String(form.get("title") || row.title).slice(0, 120);
  const durationMs = Math.max(0, Number(form.get("durationMs") || 0));
  const mimeType = audio.type || row.mimeType || "audio/webm";
  const ext = mimeType.includes("mp4") ? "m4a" : "webm";
  const audioKey = `users/${user.id}/recordings/${id}/audio.${ext}`;
  await c.env.AUDIO_BUCKET.put(audioKey, await audio.arrayBuffer(), {
    httpMetadata: { contentType: mimeType },
  });
  const latest = await db
    .select({ transcript: recordings.transcript })
    .from(recordings)
    .where(eq(recordings.id, id))
    .limit(1);
  const transcript = latest[0]?.transcript || "";
  await c.env.AUDIO_BUCKET.put(row.transcriptKey, transcript, {
    httpMetadata: { contentType: "text/plain; charset=utf-8" },
  });
  await db
    .update(recordings)
    .set({
      title,
      audioKey,
      mimeType,
      durationMs,
      transcript,
      status: "completed",
    })
    .where(eq(recordings.id, id));
  return c.json({ ok: true, id });
});

app.get("/api/recordings/:id/audio", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const [row] = await dbFor(c.env)
    .select({ audioKey: recordings.audioKey, mimeType: recordings.mimeType })
    .from(recordings)
    .where(
      and(eq(recordings.id, c.req.param("id")), eq(recordings.userId, user.id)),
    )
    .limit(1);
  if (!row) return c.json({ error: "Not found" }, 404);
  const rangeHeader = c.req.header("range");
  let range: { offset: number; length?: number } | undefined;
  if (rangeHeader && /^bytes=\d+-\d*$/.test(rangeHeader)) {
    const [startS, endS] = rangeHeader.slice(6).split("-");
    const offset = Number(startS);
    const end = endS ? Number(endS) : undefined;
    if (!Number.isNaN(offset) && offset >= 0)
      range =
        end !== undefined && end >= offset
          ? { offset, length: end - offset + 1 }
          : { offset };
  }
  const head = await c.env.AUDIO_BUCKET.head(row.audioKey);
  if (!head) return c.notFound();
  const object = await c.env.AUDIO_BUCKET.get(
    row.audioKey,
    range ? { range } : undefined,
  );
  if (!object) return c.notFound();
  const headers: Record<string, string> = {
    "Content-Type": row.mimeType,
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
    "Content-Length": String(object.size),
  };
  if (range) {
    const offset = range.offset;
    headers["Content-Range"] =
      `bytes ${offset}-${offset + object.size - 1}/${head.size}`;
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { headers });
});

app.get("/api/recordings/:id/transcript", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const [row] = await dbFor(c.env)
    .select({ transcriptKey: recordings.transcriptKey })
    .from(recordings)
    .where(
      and(eq(recordings.id, c.req.param("id")), eq(recordings.userId, user.id)),
    )
    .limit(1);
  if (!row) return c.json({ error: "Not found" }, 404);
  const object = await c.env.AUDIO_BUCKET.get(row.transcriptKey);
  if (!object) return c.notFound();
  return new Response(object.body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store",
    },
  });
});

app.delete("/api/recordings/:id", async (c) => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  const db = dbFor(c.env);
  const [row] = await db
    .select()
    .from(recordings)
    .where(
      and(eq(recordings.id, c.req.param("id")), eq(recordings.userId, user.id)),
    )
    .limit(1);
  if (!row) return c.json({ error: "Not found" }, 404);
  const chunks = await db
    .select({ objectKey: recordingChunks.objectKey })
    .from(recordingChunks)
    .where(eq(recordingChunks.recordingId, row.id));
  await c.env.AUDIO_BUCKET.delete([
    row.audioKey,
    row.transcriptKey,
    ...chunks.map((x) => x.objectKey),
  ]);
  await db.delete(recordings).where(eq(recordings.id, row.id));
  return c.json({ ok: true });
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
export default app;
