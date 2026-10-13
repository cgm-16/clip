#!/usr/bin/env bash
# Deploys the newest release image to production: resolves it with
# `scripts/release-image.sh`, renders k8s/deployment.yaml with it, applies the
# manifests, waits for the rollout to finish, then confirms the deployment is
# still at the generation that apply created and that its spec carries that
# image.
#
#   bash scripts/deploy.sh
#
# Run by Ori, never by an agent: it changes production. Two manifests are not
# applied: k8s/secret.example.yaml is a template, and a change to
# k8s/postgres.yaml (image, resources) can restart the single database instance
# in the middle of the app rollout -- apply it by hand, deliberately, when it
# changes.
set -euo pipefail

cd "$(dirname "$0")/.."

# A plain assignment, not `export CLIP_IMAGE="$(...)"`: export returns 0 even
# when the substitution fails, so only the assignment makes a refused release
# check stop the script under `set -e`.
image="$(scripts/release-image.sh)"
echo "deploying ${image}"

# release-image.sh checks HEAD, not the working tree; uncommitted manifests or
# scripts would deploy under the release commit's name.
if ! git diff --quiet HEAD -- k8s scripts; then
  git --no-pager diff --stat HEAD -- k8s scripts >&2
  echo "k8s/ or scripts/ have uncommitted changes against ${image}'s commit; commit or discard them before deploying" >&2
  exit 1
fi

rendered="$(mktemp)"
trap 'rm -f -- "$rendered"' EXIT
scripts/render-k8s-deployment.sh "$image" "$rendered"

for manifest in namespace service ingress; do
  kubectl apply -f "k8s/${manifest}.yaml"
done
is_positive_integer() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -gt 0 ]
}

applied_generation="$(kubectl apply -f "$rendered" -o jsonpath='{.metadata.generation}')"
is_positive_integer "$applied_generation" || { echo "apply returned generation '${applied_generation}', not a positive integer" >&2; exit 1; }

# rollout status waits for observedGeneration to reach the generation, then for
# the updated pods to become available. No --revision pin: under `Recreate` the
# revision annotation is bumped only after observedGeneration, so a revision
# read at that point can be the old one.
kubectl -n clip rollout status deploy/clip --timeout=5m

# Another change that overlaps the deploy (a `kubectl rollout restart`) bumps
# the generation, whether it lands during or after the rollout status above.
generation="$(kubectl -n clip get deploy clip -o jsonpath='{.metadata.generation}')"
if [ "$generation" != "$applied_generation" ]; then
  echo "deployment generation is ${generation}, not ${applied_generation}: another change superseded this deploy" >&2
  exit 1
fi

# Reads the spec just applied, not the running pods; rollout status above
# already proved the updated pods available.
deployed="$(kubectl -n clip get deploy clip -o jsonpath='{.spec.template.spec.containers[?(@.name=="clip")].image}')"
if [ "$deployed" != "$image" ]; then
  echo "deployment spec carries ${deployed}, not ${image}" >&2
  exit 1
fi
echo "deployed ${deployed}"
