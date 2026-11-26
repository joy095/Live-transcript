import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { anonymous } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from './env';
import { schema } from './db/schema';

export function createAuth(env: Env) {
  const db = drizzle(env.DB, { schema });
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    emailAndPassword: { enabled: false },
    socialProviders: env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET ? {
      github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
    } : {},
    plugins: [anonymous()],
    trustedOrigins: [env.BETTER_AUTH_URL],
  });
}
