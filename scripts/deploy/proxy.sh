#!/usr/bin/env bash
#
# Deploy a proxy image to production with proxy/deploy/blue-green.sh.
#
#   npm run deploy-proxy [-- <commit>]
#
# Like `npm run deploy-node`: run it on master, and <commit> defaults to
# master's tip. proxy-image.yml builds an image for every master push; if it
# is not published yet, wait for it (up to PROXY_IMAGE_WAIT seconds, default 25
# min, or 2 min for an explicit commit, as in deploy.yml: an older commit's
# image should already exist, and may never have been built). Runs from the operator's Mac
# or from .github/workflows/deploy-proxy.yml, over the `ssh blot` alias
# (ec2-user from the Mac, deploy from the workflow).
#
# The proxy/deploy scripts are copied from this checkout on every run, so the
# host never runs a stale copy. They go over ssh with tar rather than scp:
# ec2-user's ~/.bashrc cds to /var/www/blot, and scp's sftp server runs
# through it, so relative scp targets land in the wrong directory.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Same rule as scripts/deploy/util/checkBranch.js (the workflow sets it).
if [ "${SKIP_BRANCH_CHECK:-}" != "true" ] && [ "$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)" != master ]; then
  echo "You must be on the master branch to deploy." >&2
  exit 1
fi

if [ -n "${1:-}" ]; then
  SHA="$(git -C "$ROOT" rev-parse --verify --quiet "$1^{commit}")" \
    || { echo "Cannot resolve commit '$1'" >&2; exit 1; }
  WAIT="${PROXY_IMAGE_WAIT:-120}"
else
  SHA="$(git -C "$ROOT" rev-parse master)"
  WAIT="${PROXY_IMAGE_WAIT:-1500}"
fi
IMAGE="ghcr.io/blotcms/blot-proxy:$SHA"
echo "Deploying proxy image for commit: $SHA - $(git -C "$ROOT" log -1 --pretty=%s "$SHA")"

# Poll from the host, which pulls the image anyway, in one ssh session.
ssh blot "
  deadline=\$(( \$(date +%s) + $WAIT ))
  until docker manifest inspect $IMAGE >/dev/null 2>&1; do
    [ \$(date +%s) -lt \$deadline ] || { echo 'No image $IMAGE after ${WAIT}s: is proxy-image.yml done for this commit?' >&2; exit 1; }
    echo 'Waiting for $IMAGE...'
    sleep 15
  done
  echo 'Image found: $IMAGE'
"

echo "Copying proxy/deploy to the host"
# COPYFILE_DISABLE: macOS tar would otherwise add ._* AppleDouble files.
COPYFILE_DISABLE=1 tar -C "$ROOT/proxy" --exclude=deploy/e2e --exclude=deploy/tests -cf - deploy | ssh blot '
  set -e
  cd "$HOME"
  rm -rf proxy-deploy.new
  mkdir proxy-deploy.new
  tar -C proxy-deploy.new --strip-components=1 -xf -
  rm -rf proxy-deploy
  mv proxy-deploy.new proxy-deploy
'

echo "Running blue-green.sh $SHA on the host"
ssh blot "\$HOME/proxy-deploy/blue-green.sh $SHA"
