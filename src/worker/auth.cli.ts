// CLI-only Better Auth configuration used by `npm run auth:generate`.
// Runtime authentication is configured in auth.ts with the Cloudflare D1 Drizzle adapter.
import { betterAuth } from 'better-auth';
import { anonymous } from 'better-auth/plugins';

export const auth = betterAuth({
  emailAndPassword: { enabled: false },
  plugins: [anonymous()],
});
