#!/usr/bin/env bash
#
# Build a proxy image from a source tree (the checkout, or another commit's),
# the way the workflows do, plus one change for the swap-load
# test: the rate-limit whitelist (the Bunny edge list in
# proxy/build/data/latest/cdn-ips.conf, which http.conf turns into "no
# per-client limits") also covers every address, because the load generator
# sends hundreds of requests a second from one.
#
# Anything after the tag goes to `docker build`. swap-load.sh needs two images
# in different repositories (blue-green.sh removes the other tags of the
# repository it deploys), so build the same tree twice:
#
#   build-image.sh . blot-proxy-sl-a:e2e
#   build-image.sh . blot-proxy-sl-b:e2e --label e2e.variant=b
#
#   GENDEPS_MODULES=<dir with mustache and fs-extra in node_modules> \
#     build-image.sh <source tree> <image tag> [docker build args]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "${1:?usage: build-image.sh <source tree> <image tag> [docker build args]}" && pwd)"
TAG="${2:?usage: build-image.sh <source tree> <image tag> [docker build args]}"
shift 2
: "${GENDEPS_MODULES:?the node_modules directory holding mustache and fs-extra}"

cd "$SRC"
NODE_PATH="$GENDEPS_MODULES:$SRC/app" LOG_TO_STDOUT=false FETCH_CDN_IPS=false BLOT_HOST="${BLOT_HOST:-blot.im}" \
  bash proxy/build/build.sh
# (halves: http.conf's `default 0` is already the entry for 0.0.0.0/0)
printf '0.0.0.0/1 1;\n128.0.0.0/1 1;\n::/1 1;\n8000::/1 1;\n' >> proxy/build/data/latest/cdn-ips.conf
bash "$HERE/../../build/image.sh" "$TAG" "$@"
