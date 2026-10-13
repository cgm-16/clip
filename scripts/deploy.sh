#!/usr/bin/env bash
# Deploys the newest release image to production: resolves it with
# `scripts/release-image.sh`, renders k8s/deployment.yaml with it, applies the
# manifests, waits for the rollout, and checks the deployment runs that image.
#
#   bash scripts/deploy.sh
#
# Run by Ori, never by an agent: it changes production. k8s/secret.example.yaml
# is a template and is never applied.
set -euo pipefail

cd "$(dirname "$0")/.."

# A plain assignment, not `export CLIP_IMAGE="$(...)"`: export returns 0 even
# when the substitution fails, so only the assignment makes a refused release
# check stop the script under `set -e`.
image="$(scripts/release-image.sh)"
echo "deploying ${image}"

rendered="$(mktemp)"
trap 'rm -f -- "$rendered"' EXIT
scripts/render-k8s-deployment.sh "$image" "$rendered"

for manifest in namespace postgres service ingress; do
  kubectl apply -f "k8s/${manifest}.yaml"
done
kubectl apply -f "$rendered"

kubectl -n clip rollout status deploy/clip --timeout=5m

deployed="$(kubectl -n clip get deploy clip -o jsonpath='{.spec.template.spec.containers[?(@.name=="clip")].image}')"
if [ "$deployed" != "$image" ]; then
  echo "deployment runs ${deployed}, not ${image}" >&2
  exit 1
fi
echo "deployed ${deployed}"
