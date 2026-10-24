#!/usr/bin/env bash
#
# Run the swap-under-load e2e (swap-load.sh) on this machine, for when it is
# not a Linux box with Docker (a Mac with Docker Desktop). Builds the two images
# from this checkout with the host's Docker, then runs the harness in a
# privileged Linux container with a Docker daemon of its own (local/Dockerfile).
#
#   proxy/deploy/e2e/local.sh
#
# TCP_MIGRATE_REQ=0 leaves net.ipv4.tcp_migrate_req at the kernel's default and
# reports the connection resets. KEEP_SCRATCH=1 keeps the built images and
# trees, and RUNNER_CMD replaces what the runner does after loading them (e.g.
# a shell), for working on the test. NAME_PREFIX (default "sl-") prefixes the
# image tags, the runner image and the volume, so runs do not clash.
#
# Needs node/npm, rsync, docker. Leaves nothing behind except the runner image
# and the volume ${NAME_PREFIX}deploy-e2e-docker (its Docker's image cache;
# `docker volume rm` it to reclaim the space).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
P="${NAME_PREFIX:-sl-}"
export IMAGE_A="blot-proxy-${P}a:e2e" IMAGE_B="blot-proxy-${P}b:e2e"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/proxy-swap-load.XXXXXX")"
cleanup() {
  if [ -n "${KEEP_SCRATCH:-}" ]; then echo "kept $SCRATCH"; return; fi
  rm -rf "$SCRATCH"
  docker rmi "$IMAGE_A" "$IMAGE_B" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== source tree: this checkout (copied, so its proxy/build/data is left alone)"
mkdir -p "$SCRATCH/src/app" "$SCRATCH/src/config"
rsync -a --exclude build/data "$REPO/proxy/" "$SCRATCH/src/proxy/"
cp "$REPO/app/config.js" "$SCRATCH/src/app/"
cp "$REPO/config/index.js" "$SCRATCH/src/config/" 2>/dev/null || true
cp "$REPO/package.json" "$SCRATCH/src/"

echo "== config generator dependencies"
if [ -n "${GENDEPS_MODULES:-}" ]; then
  echo "using $GENDEPS_MODULES"
else
  mkdir -p "$SCRATCH/gendeps"
  (cd "$SCRATCH/gendeps" && npm init -y >/dev/null && npm install --no-audit --no-fund mustache@4.2.0 fs-extra@11.1.0 >/dev/null)
  export GENDEPS_MODULES="$SCRATCH/gendeps/node_modules"
fi

echo "== images"
bash "$HERE/build-image.sh" "$SCRATCH/src" "$IMAGE_A"
bash "$HERE/build-image.sh" "$SCRATCH/src" "$IMAGE_B" --label e2e.variant=b
docker pull -q node:22-alpine >/dev/null; docker pull -q redis:7-alpine >/dev/null
mkdir -p "$SCRATCH/images"
docker save -o "$SCRATCH/images/images.tar" "$IMAGE_A" "$IMAGE_B" node:22-alpine redis:7-alpine

echo "== runner"
docker build -q -t "blot-${P}deploy-e2e-runner" "$HERE/local" >/dev/null
docker run --rm --privileged \
  -e IMAGE_A -e IMAGE_B -e TCP_MIGRATE_REQ -e ALLOW_FAILED_SWAP_STALE \
  -v "${P}deploy-e2e-docker":/var/lib/docker \
  -v "$REPO":/repo:ro -v "$SCRATCH/images":/images:ro \
  "blot-${P}deploy-e2e-runner" ${RUNNER_CMD:-bash /repo/proxy/deploy/e2e/local/entry.sh}
