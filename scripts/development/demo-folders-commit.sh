#!/usr/bin/env bash
# Commits a change to the demo folders in both places it has to go (#2940):
# inside the submodule app/templates/folders (blotcms/demo-folders), pushed
# to its master, then the new submodule pointer in this repository, which is
# left for you to push or open a PR with as usual.
#
#   npm run demo-folders:commit -- "Add a gallery folder"
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FOLDERS="$ROOT/app/templates/folders"
MESSAGE="${1:-}"

if [ -z "$MESSAGE" ]; then
  echo "Usage: npm run demo-folders:commit -- \"<message>\"" >&2
  exit 1
fi

if [ -z "$(git -C "$FOLDERS" status --porcelain)" ]; then
  echo "Nothing to commit in app/templates/folders" >&2
  exit 1
fi

# The submodule is checked out at a detached commit; commit on master
if ! git -C "$FOLDERS" symbolic-ref -q HEAD >/dev/null; then
  git -C "$FOLDERS" fetch -q origin master
  if [ "$(git -C "$FOLDERS" rev-parse HEAD)" != "$(git -C "$FOLDERS" rev-parse origin/master)" ]; then
    echo "app/templates/folders is at a commit other than demo-folders' master: check out master there first" >&2
    exit 1
  fi
  git -C "$FOLDERS" checkout -q -B master origin/master
fi

git -C "$FOLDERS" add -A
git -C "$FOLDERS" commit -q -m "$MESSAGE"
git -C "$FOLDERS" push -q origin master

git -C "$ROOT" add app/templates/folders
git -C "$ROOT" commit -q -m "Demo folders: $MESSAGE"
echo "Committed in blotcms/demo-folders ($(git -C "$FOLDERS" rev-parse --short HEAD)) and the pointer here ($(git -C "$ROOT" rev-parse --short HEAD))"
