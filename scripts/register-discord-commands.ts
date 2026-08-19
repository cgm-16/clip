#!/usr/bin/env tsx
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { DISCORD_COMMANDS } from '../lib/discord/commands';

// This script's own inputs, validated locally rather than by lib/env.ts's
// EnvSchema. DISCORD_TEST_GUILD_ID has no meaning to the deployed app — only
// this developer tool needs a guild to scope registration to (guild-scoped
// commands propagate immediately; global commands take up to an hour) — so
// widening the app's required environment schema for it is the wrong fix.
const RegisterEnvSchema = z.object({
  DISCORD_APPLICATION_ID: z.string().min(1),
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_TEST_GUILD_ID: z.string().min(1),
});

type RegisterEnv = z.infer<typeof RegisterEnvSchema>;

function parseRegisterEnv(source: Record<string, string | undefined>): RegisterEnv {
  const result = RegisterEnvSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')} (${issue.message})`)
      .join(', ');
    throw new Error(`Invalid environment: ${details}`);
  }
  return result.data;
}

export type RegisterCommandsDeps = {
  fetchImpl: typeof fetch;
  envSource: Record<string, string | undefined>;
};

// Only `--register` triggers a real request. Every other invocation —
// including a bare `tsx scripts/register-discord-commands.ts` — must dry-run
// and touch neither the environment nor the network, since running this
// script by accident is expected to happen.
function shouldRegister(argv: readonly string[]): boolean {
  return argv.includes('--register');
}

async function putGuildCommands(env: RegisterEnv, fetchImpl: typeof fetch): Promise<void> {
  const url = `https://discord.com/api/v10/applications/${env.DISCORD_APPLICATION_ID}/guilds/${env.DISCORD_TEST_GUILD_ID}/commands`;
  const response = await fetchImpl(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
    },
    body: JSON.stringify(DISCORD_COMMANDS),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord command registration failed: ${response.status} ${body}`);
  }
}

export async function main(argv: readonly string[], deps: RegisterCommandsDeps): Promise<void> {
  console.log(`Command payloads (${DISCORD_COMMANDS.length}):`);
  console.log(JSON.stringify(DISCORD_COMMANDS, null, 2));

  if (!shouldRegister(argv)) {
    console.log('\nDry run: no network call made. Pass --register to actually register these.');
    return;
  }

  const env = parseRegisterEnv(deps.envSource);
  await putGuildCommands(env, deps.fetchImpl);
  console.log(`\nRegistered ${DISCORD_COMMANDS.length} guild command(s) for guild ${env.DISCORD_TEST_GUILD_ID}.`);
}

// Guarded so importing this module for tests never runs the CLI body —
// realpath comparison (rather than `process.argv[1] === import.meta.url`)
// because macOS resolves /tmp through a /private symlink and a naive string
// compare would falsely say "not the entrypoint" when invoked directly.
const isEntryPoint = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);

if (isEntryPoint) {
  void main(process.argv.slice(2), { fetchImpl: fetch, envSource: process.env }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
