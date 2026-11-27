#!/usr/bin/env bash
# Downloads the latest pane-qa renders for a branch (default: the current one)
# into app/helper/pane/rendered/<os>/, so qa/diff.js and the viewer use them.
# pane-qa uploads them as artifacts on a push instead of committing them.
# Usage: app/helper/pane/qa/fetch-rendered.sh [branch] [os ...]
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
BRANCH=${1:-$(git branch --show-current)}
shift || true
OSES=${*:-macos windows linux}
# the latest finished run, failed or not: a failing diff still uploads its renders
RUN=$(gh run list --repo blotcms/blot --workflow pane-qa.yml --branch "$BRANCH" \
  --status completed --limit 1 --json databaseId --jq '.[0].databaseId // empty')
[ -n "$RUN" ] || { echo "no pane-qa run for $BRANCH" >&2; exit 1; }
echo "pane-qa run $RUN ($BRANCH)"
for os in $OSES; do
  TMP=$(mktemp -d)
  if gh run download "$RUN" --repo blotcms/blot -n "pane-qa-$os" -D "$TMP"; then
    rm -rf "app/helper/pane/rendered/$os"
    mkdir -p "app/helper/pane/rendered/$os"
    cp "$TMP"/*.png "app/helper/pane/rendered/$os/"
    echo "  $os: $(ls "$TMP"/*.png | wc -l | tr -d ' ') images"
  else
    echo "  $os: no artifact in run $RUN" >&2
  fi
  rm -rf "$TMP"
done
