#!/usr/bin/env bash
#
# Deploy a proxy image to production with proxy/deploy/blue-green.sh.
#
#   npm run deploy-proxy [-- <commit>]
#
# <commit> defaults to the newest master commit with a successful proxy-image
# build (proxy-image.yml only builds commits that touch the proxy, so master's
# tip often has no image). Runs from the operator's Mac or from
# .github/workflows/deploy-proxy.yml, over the `ssh blot` alias (ec2-user from
# the Mac, deploy from the workflow).
#
# The proxy/deploy scripts are copied from this checkout on every run, so the
# host never runs a stale copy. They go over ssh with tar rather than scp:
# ec2-user's ~/.bashrc cds to /var/www/blot, and scp's sftp server runs
# through it, so relative scp targets land in the wrong directory.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [ -n "${1:-}" ]; then
  SHA="$(git -C "$ROOT" rev-parse --verify --quiet "$1^{commit}")" \
    || { echo "Cannot resolve commit '$1'" >&2; exit 1; }
else
  command -v gh >/dev/null 2>&1 || { echo "Pass a commit, or install the gh CLI to find the latest proxy image" >&2; exit 1; }
  SHA="$(gh run list --repo blotcms/blot --workflow proxy-image.yml --branch master \
    --event push --status success --limit 1 --json headSha --jq '.[0].headSha')"
  [ -n "$SHA" ] || { echo "No successful proxy-image build on master" >&2; exit 1; }
  echo "Latest proxy image on master: $SHA"
fi

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
