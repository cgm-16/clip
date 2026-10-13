#!/usr/bin/env tsx
/**
 * Seeds the setup tokens the Playwright suite (`e2e/`) spends, through the
 * app's own admin-session service, and prints them as `export E2E_...=...`
 * lines for `eval`. It never prints the database URL or the session secret.
 *
 * Every run only inserts fresh setup-token rows (and one admin session, from
 * spending the "used" token), so running it twice is harmless. Tokens live 15
 * minutes: run the suite right after seeding.
 *
 * The token's admin is the guild's current configurer, so the setup spec's
 * re-save writes back the same `configuredByUserId`. For a configured guild,
 * `--user` may be omitted or must name that configurer; any other user is
 * refused. A guild with no configuration has no configurer, and then
 * `--user <discord user id>` is required.
 *
 * Locally (dev server started with the same `.env`):
 *
 *   eval "$(pnpm exec tsx --env-file=.env scripts/e2e-seed.ts --guild <guild-id>)"
 *   E2E_BASE_URL=http://localhost:3077 pnpm e2e
 *
 * Against production, use `scripts/e2e-prod.sh <guild-id>`: it runs every step
 * below in one process and refuses a checkout whose app code differs from the
 * deployed image. The manual steps, for when the script itself is in question:
 *
 * The hash of a token is keyed by ADMIN_SESSION_SECRET, so the seed must use
 * production's. Run from a checkout that has this script; the suite then
 * measures the deployed image, so first check what it lacks:
 *
 *   kubectl -n clip get deploy clip -o jsonpath='{.spec.template.spec.containers[0].image}'
 *   # ghcr.io/cgm-16/clip:sha-<7> (scripts/release-image.sh)
 *   git diff <that sha>..HEAD --stat -- prisma/ app/ lib/
 *
 *   # Terminal 1: leave running. `clip-db-rw` is CloudNativePG's read-write
 *   # service for the `clip-db` cluster in k8s/postgres.yaml.
 *   kubectl -n clip port-forward svc/clip-db-rw 15432:5432
 *
 *   # Terminal 2. Nothing below echoes a secret.
 *   export DATABASE_URL="$(kubectl -n clip get secret clip-db-app -o jsonpath='{.data.uri}' | base64 -d | sed -E 's#@[^/]+/#@localhost:15432/#')"
 *   export ADMIN_SESSION_SECRET="$(kubectl -n clip get secret clip-env -o jsonpath='{.data.ADMIN_SESSION_SECRET}' | base64 -d)"
 *   export PUBLIC_BASE_URL=https://clipendpoint.cc
 *   # Never read by the seed; lib/env.ts only requires them to be set.
 *   export DISCORD_APPLICATION_ID=unused DISCORD_PUBLIC_KEY=unused DISCORD_BOT_TOKEN=unused
 *   # `pnpm install` does not generate the Prisma client; without it the seed
 *   # fails with "Cannot find module '../generated/prisma/client'".
 *   pnpm exec prisma generate
 *   eval "$(pnpm exec tsx scripts/e2e-seed.ts --guild <guild-id>)"
 *   E2E_BASE_URL=https://clipendpoint.cc pnpm e2e
 *   unset DATABASE_URL ADMIN_SESSION_SECRET PUBLIC_BASE_URL DISCORD_APPLICATION_ID DISCORD_PUBLIC_KEY DISCORD_BOT_TOKEN \
 *     E2E_GUILD_ID E2E_ARCHIVE_CHANNEL_ID E2E_SETUP_TOKEN E2E_ARCHIVE_TOKEN E2E_DELETION_TOKEN E2E_EXPIRED_TOKEN E2E_USED_TOKEN
 */
import { parseArgs } from 'node:util';
import { exchangeSetupToken, issueSetupToken } from '../lib/admin-session/service';
import { SETUP_TOKEN_TTL_MS } from '../lib/admin-session/tokens';
import { getPrismaClient } from '../lib/db';

const USAGE = 'Usage: tsx scripts/e2e-seed.ts --guild <guild-id> [--user <discord-user-id>]';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { guild: { type: 'string' }, user: { type: 'string' } } });
  const guildId = values.guild;
  // Word characters only: every value lands in a line the caller `eval`s.
  const safe = /^[\w-]+$/;
  if (!guildId || !safe.test(guildId) || (values.user !== undefined && !safe.test(values.user))) {
    throw new Error(USAGE);
  }

  const prisma = getPrismaClient();
  try {
    const config = await prisma.guildConfig.findUnique({
      where: { guildId },
      select: { archiveChannelId: true, configuredByUserId: true },
    });
    if (config && values.user !== undefined && values.user !== config.configuredByUserId) {
      throw new Error(
        `Guild ${guildId} is configured by ${config.configuredByUserId}; the setup spec's re-save writes the token's user back as the configurer, so --user must be omitted or name that user.`,
      );
    }
    const userId = values.user ?? config?.configuredByUserId;
    if (!userId) {
      throw new Error(`Guild ${guildId} has no configuration, so --user is required. ${USAGE}`);
    }

    const now = new Date();
    const issue = async (at: Date = now) => (await issueSetupToken(guildId, userId, at)).token;

    const used = await issue();
    if ((await exchangeSetupToken(used, now)) === null) {
      throw new Error('Could not spend the seeded "used" token');
    }

    const exports: Record<string, string> = {
      E2E_GUILD_ID: guildId,
      // Empty for an unconfigured guild: the setup spec then takes the first-setup branch.
      E2E_ARCHIVE_CHANNEL_ID: config?.archiveChannelId ?? '',
      E2E_SETUP_TOKEN: await issue(),
      E2E_ARCHIVE_TOKEN: await issue(),
      E2E_DELETION_TOKEN: await issue(),
      // Expired a day ago by this machine's clock, which the pod's may not match:
      // no plausible skew between the two can make it live again.
      E2E_EXPIRED_TOKEN: await issue(new Date(now.getTime() - SETUP_TOKEN_TTL_MS - 24 * 60 * 60 * 1000)),
      E2E_USED_TOKEN: used,
    };
    // Every line is `eval`ed, so refuse the lot unless each value needs no quoting.
    const unsafe = Object.entries(exports).find(([, value]) => !/^[\w-]*$/.test(value));
    if (unsafe) {
      throw new Error(`Refusing to print ${unsafe[0]}: its value is not word characters only`);
    }
    for (const [name, value] of Object.entries(exports)) {
      console.log(`export ${name}=${value}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
