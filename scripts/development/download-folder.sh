#!/usr/bin/env bash
set -euo pipefail

# Downloads a production blog's folder to ~/Downloads/<blog ID>, read from the
# storage bucket by scripts/blog/export-folder.js in a production container.

read -r -p 'Enter blog identifier: ' IDENTIFIER

BLOGID="$(ssh -T blot "docker exec blot-blue node /usr/src/app/scripts/info \"$IDENTIFIER\"" | grep 'blog_' | head -n1 | cut -d ' ' -f 2)"

if [ -z "$BLOGID" ]; then
  echo "Could not find a blog for '$IDENTIFIER'" >&2
  exit 1
fi

DEST="$HOME/Downloads/$BLOGID"
mkdir -p "$DEST"
ssh -T blot "docker exec blot-blue node /usr/src/app/scripts/blog/export-folder \"$BLOGID\"" | tar -x -C "$DEST"
open "$DEST"
