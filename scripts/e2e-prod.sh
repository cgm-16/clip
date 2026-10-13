#!/usr/bin/env bash
# Runs the Playwright suite (e2e/) against the production deployment, end to
# end, in one process: port-forward to the production database, seed setup
# tokens with `scripts/e2e-seed.ts`, run the suite, tear the port-forward down.
#
#   bash scripts/e2e-prod.sh <guild-id> [playwright args...]
#   bash scripts/e2e-prod.sh 1559501336641404960 -g "pagination|channel filter"
#
# Run by Ori, never by an agent: it reads production secrets and writes setup
# tokens into the production database. Nothing it runs prints a secret, and
# every secret lives only in this process's environment, so nothing needs
# unsetting afterwards. The guild's archive should hold more than 20 clips, or
# the pagination test skips itself.
set -euo pipefail

guild="${1:?usage: bash scripts/e2e-prod.sh <guild-id> [playwright args...]}"
shift

cd "$(dirname "$0")/.."

# The suite measures the deployed image with this checkout's tests and seed.
# Refuse when the code they run against differs from what is deployed;
# docs-only drift is fine.
image="$(kubectl -n clip get deploy clip -o jsonpath='{.spec.template.spec.containers[?(@.name=="clip")].image}')"
deployed_sha="${image##*:sha-}"
if ! git cat-file -e "${deployed_sha}^{commit}" 2>/dev/null; then
  git fetch -q origin
fi
if ! git diff --quiet "$deployed_sha" HEAD -- app lib prisma; then
  echo "deployed image is sha-${deployed_sha}, but this checkout's app/, lib/ or prisma/ differ from it:" >&2
  git --no-pager diff --stat "$deployed_sha" HEAD -- app lib prisma >&2
  echo "check out sha-${deployed_sha}'s commit, or deploy this one first" >&2
  exit 1
fi

port=15432
kubectl -n clip port-forward svc/clip-db-rw "${port}:5432" >/dev/null 2>&1 &
port_forward=$!
trap 'kill "$port_forward" 2>/dev/null || true' EXIT

for _ in $(seq 1 20); do
  if nc -z localhost "$port" 2>/dev/null; then break; fi
  sleep 0.5
done
if ! nc -z localhost "$port" 2>/dev/null; then
  echo "port-forward to svc/clip-db-rw did not open localhost:${port}" >&2
  exit 1
fi

DATABASE_URL="$(kubectl -n clip get secret clip-db-app -o jsonpath='{.data.uri}' | base64 -d | sed -E "s#@[^/]+/#@localhost:${port}/#")"
ADMIN_SESSION_SECRET="$(kubectl -n clip get secret clip-env -o jsonpath='{.data.ADMIN_SESSION_SECRET}' | base64 -d)"
export DATABASE_URL ADMIN_SESSION_SECRET
export PUBLIC_BASE_URL=https://clipendpoint.cc
# Never read by the seed; lib/env.ts only requires them to be set.
export DISCORD_APPLICATION_ID=unused DISCORD_PUBLIC_KEY=unused DISCORD_BOT_TOKEN=unused

# The Prisma client is generated code that `pnpm install` does not produce.
# Generation reads DATABASE_URL for its config but never connects.
if [ ! -d generated/prisma ]; then
  pnpm exec prisma generate >/dev/null
fi

# A plain assignment, not `eval "$(...)"`: only the assignment makes a failed
# seed stop the script under `set -e`.
seed="$(pnpm exec tsx scripts/e2e-seed.ts --guild "$guild")"
eval "$seed"

E2E_BASE_URL=https://clipendpoint.cc pnpm e2e "$@"
