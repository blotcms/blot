#!/usr/bin/env bash
set -euo pipefail

# Copies a production site into the local development stack so it can be
# debugged or edited: creates a new blog on example@example.com, downloads the
# site's folder, and adds the installed template to its Templates folder.
#
#   npm run fork [blog identifier]

LOCAL_CONTAINER="${BLOT_LOCAL_CONTAINER:-blot-node-app-1}"
PROD_CONTAINER="blot-container-blue"
PROD_BLOGS_DIR="/var/www/blot/data/blogs"

# Local blog folders live in ./data/blogs of the checkout running the Docker
# stack. Inside a worktree that is the main checkout, not the worktree.
if [ -z "${BLOT_LOCAL_DATA_DIR:-}" ]; then
  COMMON_GIT_DIR="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
  BLOT_LOCAL_DATA_DIR="$(dirname "$COMMON_GIT_DIR")/data"
fi
LOCAL_BLOGS_DIR="$BLOT_LOCAL_DATA_DIR/blogs"

if [ $# -ge 1 ]; then
  IDENTIFIER="$1"
else
  read -r -p 'Enter blog identifier: ' IDENTIFIER
fi

echo "Looking up $IDENTIFIER on production..."
PROD_BLOG_ID="$(ssh -T blot "docker exec $PROD_CONTAINER node /usr/src/app/scripts/info \"$IDENTIFIER\"" | grep 'blog_' | head -n1 | cut -d ' ' -f 2)"

if [ -z "$PROD_BLOG_ID" ]; then
  echo "Could not find a blog for '$IDENTIFIER'" >&2
  exit 1
fi

# Derive a local handle from the identifier (URL, handle or blog ID)
HANDLE_BASE="$(echo "$IDENTIFIER" | sed -E 's#^[a-zA-Z]+://##; s#[/:].*$##; s#\..*$##' | tr -cd 'a-zA-Z0-9')"
[ -n "$HANDLE_BASE" ] && [ "${#HANDLE_BASE}" -ge 2 ] || HANDLE_BASE="fork"

echo "Downloading site settings..."
SETTINGS="$(ssh -T blot "docker exec $PROD_CONTAINER node /usr/src/app/scripts/blog/export-settings \"$PROD_BLOG_ID\"")"

echo "Creating local site..."
CREATED="$(echo "$SETTINGS" | docker exec -i "$LOCAL_CONTAINER" node /usr/src/app/scripts/development/fork create "$HANDLE_BASE")"
LOCAL_BLOG_ID="$(echo "$CREATED" | sed -n 's/^blogID=//p')"
if [ -z "$LOCAL_BLOG_ID" ]; then
  echo "Failed to create local site: $CREATED" >&2
  exit 1
fi
LOCAL_FOLDER="$LOCAL_BLOGS_DIR/$LOCAL_BLOG_ID"
echo "Created $LOCAL_BLOG_ID"

echo "Downloading folder $PROD_BLOG_ID..."
mkdir -p "$LOCAL_FOLDER"
rsync -avz "blot:$PROD_BLOGS_DIR/$PROD_BLOG_ID/" "$LOCAL_FOLDER/"

echo "Downloading installed template..."
ZIP="$(mktemp /tmp/fork-template.XXXXXX)"
trap 'rm -f "$ZIP"' EXIT

TEMPLATE_SLUG=""
set +e
ssh -T blot "docker exec $PROD_CONTAINER node /usr/src/app/scripts/template/export-zip \"$PROD_BLOG_ID\"" > "$ZIP"
STATUS=$?
set -e

if [ "$STATUS" -eq 3 ]; then
  echo "Template is already in the site's folder (localEditing), skipping"
elif [ "$STATUS" -ne 0 ]; then
  echo "Failed to export template (exit $STATUS)" >&2
  exit "$STATUS"
else
  # Match the existing folder's casing, as models/template/determineTemplateFolder does
  TEMPLATES_DIR="Templates"
  [ -d "$LOCAL_FOLDER/templates" ] && [ ! -d "$LOCAL_FOLDER/Templates" ] && TEMPLATES_DIR="templates"
  mkdir -p "$LOCAL_FOLDER/$TEMPLATES_DIR"
  TEMPLATE_SLUG="$(unzip -Z1 "$ZIP" | awk -F/ 'NR==1{print $1; exit}')"
  unzip -q -o "$ZIP" -d "$LOCAL_FOLDER/$TEMPLATES_DIR"
  echo "Added template $TEMPLATES_DIR/$TEMPLATE_SLUG"
fi

echo "Building local site..."
docker exec "$LOCAL_CONTAINER" node /usr/src/app/scripts/development/fork finish "$LOCAL_BLOG_ID" ${TEMPLATE_SLUG:+"$TEMPLATE_SLUG"}

echo "Done: $LOCAL_FOLDER"
open "$LOCAL_FOLDER" || true
