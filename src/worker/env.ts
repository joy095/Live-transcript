export type Env = {
  DB: D1Database;
  AUDIO_BUCKET: R2Bucket;
  AI: Ai;
  ASSETS: Fetcher;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
};
