#!/usr/bin/env bash
# Prints the image a deploy should use: the GHCR sha-<7> tag of the newest
# `release` run triggered by a push to main (docs/02_CLIP_IMPLEMENTATION_PLAN.md
# Task 0.2). Refuses unless that newest run completed successfully, so an
# in-progress or failed build is never skipped over in favour of an older image.
#
#   export CLIP_IMAGE="$(scripts/release-image.sh)"
set -euo pipefail

run="$(gh run list --repo cgm-16/clip --workflow release --branch main --event push --limit 1 \
  --json status,conclusion,headSha --jq '.[0] | [.status, .conclusion, .headSha] | join("|")')"
if [ -z "$run" ]; then
  echo "no release run found for a push to main" >&2
  exit 1
fi

# `|`, not a tab: tab counts as whitespace for `read`, so the empty conclusion
# of a run in progress would collapse and shift the commit into its place.
IFS='|' read -r status conclusion head_sha <<<"$run"
if [ "$status" != completed ] || [ "$conclusion" != success ]; then
  echo "newest release run on main is ${status}${conclusion:+/$conclusion} (commit ${head_sha:0:7}); wait for it or fix it before deploying" >&2
  exit 1
fi

# The deploy applies k8s/ from the checkout it runs in, so the manifests must
# come from the same commit as the image -- not from whatever branch is out.
checkout_sha="$(git rev-parse HEAD)"
if [ "$checkout_sha" != "$head_sha" ]; then
  echo "this checkout is at ${checkout_sha:0:7}, but the release image is from ${head_sha:0:7}; deploy from a checkout of that commit:" >&2
  echo "  git fetch origin && git checkout --detach $head_sha" >&2
  exit 1
fi

printf 'ghcr.io/cgm-16/clip:sha-%s\n' "${head_sha:0:7}"
