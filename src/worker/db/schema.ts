import { integer, index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Better Auth tables. Keep field names aligned with Better Auth's SQLite schema.
export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('emailVerified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  isAnonymous: integer('isAnonymous', { mode: 'boolean' }).notNull().default(false),
});

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expiresAt', { mode: 'timestamp_ms' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  userId: text('userId').notNull().references(() => user.id, { onDelete: 'cascade' }),
}, (t) => ({ userIdx: index('session_userId_idx').on(t.userId) }));

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  userId: text('userId').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  idToken: text('idToken'),
  accessTokenExpiresAt: integer('accessTokenExpiresAt', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refreshTokenExpiresAt', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('createdAt', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
}, (t) => ({ userIdx: index('account_userId_idx').on(t.userId) }));

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expiresAt', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('createdAt', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
  updatedAt: integer('updatedAt', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
}, (t) => ({ identifierIdx: index('verification_identifier_idx').on(t.identifier) }));

export const recordings = sqliteTable('recordings', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  audioKey: text('audio_key').notNull(),
  transcriptKey: text('transcript_key').notNull(),
  mimeType: text('mime_type').notNull(),
  durationMs: integer('duration_ms').notNull().default(0),
  transcript: text('transcript').notNull().default(''),
  status: text('status').notNull().default('recording'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (t) => ({ userCreatedIdx: index('recordings_user_created_idx').on(t.userId, t.createdAt) }));

export const recordingChunks = sqliteTable('recording_chunks', {
  id: text('id').primaryKey(),
  recordingId: text('recording_id').notNull().references(() => recordings.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  chunkIndex: integer('chunk_index').notNull(),
  objectKey: text('object_key').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  transcript: text('transcript').notNull().default(''),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (t) => ({ recordingIdx: index('recording_chunks_recording_idx').on(t.recordingId, t.chunkIndex) }));

export const schema = { user, session, account, verification, recordings, recordingChunks };
