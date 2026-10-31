#!/usr/bin/env bash
#
# Builds the proxy image from the tree in the current directory, the way the
# workflows do. With PROXY_IMAGE_CACHE set to a registry cache (the one
# unit-image.yml writes on master), the compiled stages (OpenResty, Brotli, the
# Lua dependencies) come from it, so only the generated config is new. Without
# it, or if the cache can't be read, this is a plain build from source.
#
# Anything after the tag goes to `docker build`.
#
#   PROXY_IMAGE_CACHE=<ref> bash proxy/build/image.sh <image tag> [docker build args]
set -euo pipefail

TAG="${1:?usage: image.sh <image tag> [docker build args]}"
shift

CACHE=()
if [ -n "${PROXY_IMAGE_CACHE:-}" ]; then
  CACHE=(--cache-from "type=registry,ref=$PROXY_IMAGE_CACHE")
fi

docker build "${CACHE[@]}" -f proxy/Dockerfile -t "$TAG" "$@" proxy/
