import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().min(1),
  DISCORD_PUBLIC_KEY: z.string().min(1),
  DISCORD_BOT_TOKEN: z.string().min(1),
  // Long enough that a session token derived from it is not brute-forceable.
  ADMIN_SESSION_SECRET: z.string().min(32),
  // No trailing slash: this is concatenated with paths to build the setup URL
  // Discord hands the admin, and `https://host//setup/x` would 404.
  PUBLIC_BASE_URL: z.url().refine((v) => !v.endsWith('/'), 'must not end with a slash'),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Validates an environment source.
 *
 * Throws naming every offending variable, not just the first, so a
 * misconfigured deployment fails at startup with one diagnosable message
 * rather than one restart per mistake.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')} (${issue.message})`)
      .join(', ');
    throw new Error(`Invalid environment: ${details}`);
  }
  return result.data;
}
