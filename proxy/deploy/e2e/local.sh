#!/usr/bin/env bash
#
# Run the legacy <-> disk transition e2e (transition.sh) on this machine, for
# when it is not a Linux box with Docker (a Mac with Docker Desktop). Builds
# both images with the host's Docker, then runs the harness in a privileged
# Linux container with a Docker daemon of its own (local/Dockerfile).
#
#   proxy/deploy/e2e/local.sh [legacy ref]
#
# KEEP_SCRATCH=1 keeps the built images and trees, and RUNNER_CMD replaces what
# the runner does after loading them (e.g. a shell), for working on the test.
#
# The legacy image is built from a commit that still has cacher.lua (default:
# the one the workflow pins). Needs git, node/npm, docker. Leaves nothing
# behind except the runner image and the volume blot-deploy-e2e-docker (its
# Docker's image cache; `docker volume rm` it to reclaim the space).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
LEGACY_REF="${1:-${LEGACY_REF:-$(sed -n 's/^ *LEGACY_REF: *//p' "$REPO/.github/workflows/proxy-deploy-e2e.yml" | head -1)}}"
[ -n "$LEGACY_REF" ] || { echo "no legacy ref" >&2; exit 1; }

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/proxy-transition.XXXXXX")"
cleanup() {
  if [ -n "${KEEP_SCRATCH:-}" ]; then echo "kept $SCRATCH (git worktree remove --force $SCRATCH/legacy when done)"; return; fi
  git -C "$REPO" worktree remove --force "$SCRATCH/legacy" 2>/dev/null || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

echo "== source trees: legacy $LEGACY_REF, and this checkout (copied, so its proxy/build/data is left alone)"
git -C "$REPO" worktree add --detach "$SCRATCH/legacy" "$LEGACY_REF" >/dev/null 2>&1 \
  || { git -C "$REPO" fetch origin "$LEGACY_REF" >/dev/null 2>&1; git -C "$REPO" worktree add --detach "$SCRATCH/legacy" "$LEGACY_REF" >/dev/null; }
mkdir -p "$SCRATCH/disk/app" "$SCRATCH/disk/config"
rsync -a --exclude build/data "$REPO/proxy/" "$SCRATCH/disk/proxy/"
cp "$REPO/app/config.js" "$SCRATCH/disk/app/"
cp "$REPO/config/index.js" "$SCRATCH/disk/config/" 2>/dev/null || true
cp "$REPO/package.json" "$SCRATCH/disk/"

echo "== config generator dependencies"
mkdir -p "$SCRATCH/gendeps"
(cd "$SCRATCH/gendeps" && npm init -y >/dev/null && npm install --no-audit --no-fund mustache@4.2.0 fs-extra@11.1.0 >/dev/null)
export GENDEPS_MODULES="$SCRATCH/gendeps/node_modules"

echo "== images"
bash "$HERE/build-image.sh" "$SCRATCH/legacy" blot-proxy-tr-legacy:e2e
bash "$HERE/build-image.sh" "$SCRATCH/disk" blot-proxy-tr-disk:e2e
docker pull -q node:22-alpine >/dev/null; docker pull -q redis:7-alpine >/dev/null
mkdir -p "$SCRATCH/images"
docker save -o "$SCRATCH/images/images.tar" blot-proxy-tr-legacy:e2e blot-proxy-tr-disk:e2e node:22-alpine redis:7-alpine

echo "== runner"
docker build -q -t blot-deploy-e2e-runner "$HERE/local" >/dev/null
docker run --rm --privileged \
  -v blot-deploy-e2e-docker:/var/lib/docker \
  -v "$REPO":/repo:ro -v "$SCRATCH/images":/images:ro \
  blot-deploy-e2e-runner ${RUNNER_CMD:-bash /repo/proxy/deploy/e2e/local/entry.sh}
