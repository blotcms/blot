#!/usr/bin/env bash
#
# Builds the proxy image from the tree in the current directory, the way the
# workflows do. With PROXY_IMAGE_CACHE set to a registry cache (the one
# unit-image.yml writes on master), the compiled stages (OpenResty, Brotli, the
# Lua dependencies) come from it, so only the generated config is new. Without
# it, or if the cache can't be read, this is a plain build from source.
#
# The Dockerfile has no version defaults: every pair in config/versions.env is
# passed as a build arg. Anything after the tag goes to `docker build`.
#
#   PROXY_IMAGE_CACHE=<ref> bash proxy/build/image.sh <image tag> [docker build args]
set -euo pipefail

TAG="${1:?usage: image.sh <image tag> [docker build args]}"
shift

# The tree being built has its own versions (a tree from an older commit, which
# predates the file, falls back to this checkout's).
VERSIONS=config/versions.env
[ -f "$VERSIONS" ] || VERSIONS="$(dirname "${BASH_SOURCE[0]}")/../../config/versions.env"
VERSION_ARGS=()
while IFS= read -r pair; do
  VERSION_ARGS+=(--build-arg "$pair")
done < <(grep -E '^[A-Z][A-Z0-9_]*=' "$VERSIONS")

CACHE=()
if [ -n "${PROXY_IMAGE_CACHE:-}" ]; then
  CACHE=(--cache-from "type=registry,ref=$PROXY_IMAGE_CACHE")
fi

docker build "${CACHE[@]}" "${VERSION_ARGS[@]}" -f proxy/Dockerfile -t "$TAG" "$@" proxy/
