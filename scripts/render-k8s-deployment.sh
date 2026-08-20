#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 IMAGE OUTPUT" >&2
  exit 64
fi

image="$1"
output="$2"

if [[ ! "$image" =~ ^ghcr[.]io/cgm-16/clip:sha-[a-f0-9]{7,40}$ ]]; then
  echo "image must be a released ghcr.io/cgm-16/clip:sha-<lowercase-commit> tag" >&2
  exit 65
fi

template="k8s/deployment.yaml"

if [ ! -r "$template" ]; then
  echo "missing deployment template: $template" >&2
  exit 66
fi

output_directory="$(dirname -- "$output")"
if [ ! -d "$output_directory" ]; then
  echo "output directory does not exist: $output_directory" >&2
  exit 73
fi

temporary="$(mktemp "$output.tmp.XXXXXX")"
cleanup() {
  rm -f -- "$temporary"
}
trap cleanup EXIT

sed "s|__CLIP_RELEASE_IMAGE__|$image|g" "$template" > "$temporary"

if grep -Fq '__CLIP_RELEASE_IMAGE__' "$temporary"; then
  echo "unrendered deployment image marker" >&2
  exit 65
fi

rendered_images="$(sed -nE 's/^[[:space:]]*image:[[:space:]]*([^[:space:]#]+).*/\1/p' "$temporary")"
expected_images="$(printf '%s\n%s' "$image" "$image")"
if [ "$rendered_images" != "$expected_images" ]; then
  echo "rendered manifest must contain exactly two identical Clip image values" >&2
  exit 65
fi

mv -- "$temporary" "$output"
trap - EXIT
