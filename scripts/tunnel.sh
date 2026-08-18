#!/usr/bin/env bash
# Open an SSH tunnel to the k3s API over Tailscale.
#
# The k3s API is not exposed publicly and this machine is on a different
# network, so kubectl reaches it through localhost. The stock k3s serving
# certificate already covers 127.0.0.1, which is why no --tls-san change
# is needed on the host.
set -euo pipefail

HOST="${CLIP_K3S_HOST:-ori@100.82.166.1}"   # ori-minipc over Tailscale

if kubectl cluster-info >/dev/null 2>&1; then
  echo "tunnel already up"; exit 0
fi

pkill -f 'ssh -f -N -L 6443' 2>/dev/null || true
ssh -f -N -L 6443:127.0.0.1:6443 \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 \
    -p 22 "$HOST"

for _ in $(seq 1 10); do
  kubectl get --raw /readyz >/dev/null 2>&1 && { echo "tunnel up"; exit 0; }
  sleep 1
done
echo "tunnel failed — is Tailscale connected? try: tailscale status" >&2
exit 1
