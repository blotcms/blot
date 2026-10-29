#!/usr/bin/env bash
#
# Deploy the two units, blot-blue and blot-green (OpenResty and Node in one
# container each, #2119), to production with proxy/deploy/blue-green.sh.
#
#   npm run deploy-units [-- <commit>]
#
# Run it on master, and <commit> defaults to
# master's tip. unit-image.yml builds an image for every master push; if it
# is not published yet, wait for it (up to UNIT_IMAGE_WAIT seconds, default 25
# min, or 2 min for an explicit commit, as in deploy.yml: an older commit's
# image should already exist, and may never have been built). Runs from the
# operator's Mac or from .github/workflows/deploy.yml, over the `ssh blot`
# alias (ec2-user from the Mac, deploy from the workflow).
#
# The first run on a host that still has proxy-only containers and the
# blot-container-* Node containers is the cutover: see "Cutover" in
# proxy/deploy/README.md.
#
# The proxy/deploy scripts are copied from this checkout on every run, so the
# host never runs a stale copy, together with unit-settings.env, written here
# from scripts/deploy/constants.js (the units' memory, cpus, heaps and airlock
# ports). They go over ssh with tar rather than scp: ec2-user's ~/.bashrc cds
# to /var/www/blot, and scp's sftp server runs through it, so relative scp
# targets land in the wrong directory.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Deploy only from master (the workflow sets SKIP_BRANCH_CHECK).
if [ "${SKIP_BRANCH_CHECK:-}" != "true" ] && [ "$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)" != master ]; then
  echo "You must be on the master branch to deploy." >&2
  exit 1
fi

if [ -n "${1:-}" ]; then
  SHA="$(git -C "$ROOT" rev-parse --verify --quiet "$1^{commit}")" \
    || { echo "Cannot resolve commit '$1'" >&2; exit 1; }
  WAIT="${UNIT_IMAGE_WAIT:-${PROXY_IMAGE_WAIT:-120}}"
else
  SHA="$(git -C "$ROOT" rev-parse master)"
  WAIT="${UNIT_IMAGE_WAIT:-${PROXY_IMAGE_WAIT:-1500}}"
fi
IMAGE="ghcr.io/blotcms/blot:$SHA"
echo "Deploying unit image for commit: $SHA - $(git -C "$ROOT" log -1 --pretty=%s "$SHA")"

# Poll from the host, which pulls the image anyway, in one ssh session.
ssh blot "
  deadline=\$(( \$(date +%s) + $WAIT ))
  until docker manifest inspect $IMAGE >/dev/null 2>&1; do
    [ \$(date +%s) -lt \$deadline ] || { echo 'No image $IMAGE after ${WAIT}s: is the image workflow done for this commit?' >&2; exit 1; }
    echo 'Waiting for $IMAGE...'
    sleep 5
  done
  echo 'Image found: $IMAGE'
"

echo "Copying proxy/deploy and unit-settings.env to the host"
# COPYFILE_DISABLE: macOS tar would otherwise add ._* AppleDouble files.
COPYFILE_DISABLE=1 tar -C "$ROOT/proxy" --exclude=deploy/e2e --exclude=deploy/tests -cf - deploy | ssh blot '
  set -e
  cd "$HOME"
  rm -rf proxy-deploy.new
  mkdir proxy-deploy.new
  tar -C proxy-deploy.new --strip-components=1 -xf -
'
node "$ROOT/scripts/deploy/unit-settings.js" | ssh blot '
  set -e
  cd "$HOME"
  cat > proxy-deploy.new/unit-settings.env
  rm -rf proxy-deploy
  mv proxy-deploy.new proxy-deploy
'

echo "Running blue-green.sh $SHA on the host"
ssh blot "PROXY_DEPLOY_KIND=unit \$HOME/proxy-deploy/blue-green.sh $SHA"
