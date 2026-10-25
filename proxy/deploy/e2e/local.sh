#!/usr/bin/env bash
#
# Run the swap-under-load e2e (swap-load.sh) on this machine, for when it is
# not a Linux box with Docker (a Mac with Docker Desktop). Builds the two images
# from this checkout with the host's Docker, then runs the harness in a
# privileged Linux container with a Docker daemon of its own (local/Dockerfile).
#
#   proxy/deploy/e2e/local.sh
#
# TEST=transition runs the legacy <-> disk transition e2e (transition.sh)
# instead: the legacy image is built from LEGACY_REF (default: the commit the
# workflow pins, which still has cacher.lua), the disk image from this checkout.
#
# TCP_MIGRATE_REQ=0 leaves net.ipv4.tcp_migrate_req at the kernel's default and
# reports the connection resets. KEEP_SCRATCH=1 keeps the built images and
# trees, and RUNNER_CMD replaces what the runner does after loading them (e.g.
# a shell), for working on the test. NAME_PREFIX (default "sl-") prefixes the
# image tags, the runner image and the volume, so runs do not clash.
#
# Needs node/npm, rsync, docker (and git for TEST=transition). Leaves nothing behind except the runner image
# and the volume ${NAME_PREFIX}deploy-e2e-docker (its Docker's image cache;
# `docker volume rm` it to reclaim the space).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
P="${NAME_PREFIX:-sl-}"
export IMAGE_A="blot-proxy-${P}a:e2e" IMAGE_B="blot-proxy-${P}b:e2e"
export IMAGE_LEGACY="blot-proxy-${P}legacy:e2e" IMAGE_DISK="blot-proxy-${P}disk:e2e"
export TEST="${TEST:-swap-load}"
if [ "$TEST" = transition ]; then
  LEGACY_REF="${LEGACY_REF:-$(sed -n 's/^ *LEGACY_REF: *//p' "$REPO/.github/workflows/proxy-deploy-e2e.yml" | head -1)}"
  [ -n "$LEGACY_REF" ] || { echo "no legacy ref" >&2; exit 1; }
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/proxy-swap-load.XXXXXX")"
cleanup() {
  if [ -n "${KEEP_SCRATCH:-}" ]; then echo "kept $SCRATCH"; return; fi
  git -C "$REPO" worktree remove --force "$SCRATCH/legacy" 2>/dev/null || true
  rm -rf "$SCRATCH"
  docker rmi "$IMAGE_A" "$IMAGE_B" "$IMAGE_LEGACY" "$IMAGE_DISK" >/dev/null 2>&1 || true
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
if [ "$TEST" = transition ]; then
  git -C "$REPO" worktree add --detach "$SCRATCH/legacy" "$LEGACY_REF" >/dev/null 2>&1 \
    || { git -C "$REPO" fetch origin "$LEGACY_REF" >/dev/null 2>&1; git -C "$REPO" worktree add --detach "$SCRATCH/legacy" "$LEGACY_REF" >/dev/null; }
  bash "$HERE/build-image.sh" "$SCRATCH/legacy" "$IMAGE_LEGACY"
  bash "$HERE/build-image.sh" "$SCRATCH/src" "$IMAGE_DISK"
  IMAGES="$IMAGE_LEGACY $IMAGE_DISK"
else
  bash "$HERE/build-image.sh" "$SCRATCH/src" "$IMAGE_A"
  bash "$HERE/build-image.sh" "$SCRATCH/src" "$IMAGE_B" --label e2e.variant=b
  IMAGES="$IMAGE_A $IMAGE_B"
fi
docker pull -q node:22-alpine >/dev/null; docker pull -q redis:7-alpine >/dev/null
mkdir -p "$SCRATCH/images"
# shellcheck disable=SC2086
docker save -o "$SCRATCH/images/images.tar" $IMAGES node:22-alpine redis:7-alpine

echo "== runner"
docker build -q -t "blot-${P}deploy-e2e-runner" "$HERE/local" >/dev/null
docker run --rm --privileged \
  -e TEST -e IMAGE_A -e IMAGE_B -e IMAGE_LEGACY -e IMAGE_DISK -e TCP_MIGRATE_REQ -e ALLOW_FAILED_SWAP_STALE \
  -v "${P}deploy-e2e-docker":/var/lib/docker \
  -v "$REPO":/repo:ro -v "$SCRATCH/images":/images:ro \
  "blot-${P}deploy-e2e-runner" ${RUNNER_CMD:-bash /repo/proxy/deploy/e2e/local/entry.sh}
