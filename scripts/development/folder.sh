#!/usr/bin/env bash
set -euo pipefail

# Resolve repo paths
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && cd ../../ && pwd)"
FOLDERS_DIR="$DIR/app/templates/folders"

# Get list of available folders (directories that don't start with . or -)
get_available_folders() {
  find "$FOLDERS_DIR" -maxdepth 1 -type d -not -path "$FOLDERS_DIR" | while read -r folder; do
    basename "$folder"
  done | grep -v '^\.' | grep -v '^-' | sort
}

# Test sites built by scripts/development/sites (not demo folders)
TEST_SITES="empty tiny huge torture arabic japanese"

sites() {
  docker exec blot-node-app-1 node scripts/development/sites "$@"
}

# npm keeps flags such as --down for itself and sets npm_config_down instead
if [ "${npm_config_down:-}" = "true" ]; then
  sites down "$@"
  exit 0
fi
if [ "${1:-}" = "--down" ] || [ "${1:-}" = "down" ]; then
  shift
  sites down "$@"
  exit 0
fi

# With no argument, build every demo folder site and every test site
if [ $# -eq 0 ] || [ "$1" = "up" ]; then
  sites up
  exit 0
fi

if [ "$1" = "list" ]; then
  echo "Available folders:"
  echo ""
  folders=$(get_available_folders)
  while IFS= read -r folder; do
    echo "  npm run folder $folder"
  done <<< "$folders"
  echo ""
  echo "Test sites:"
  echo ""
  for site in $TEST_SITES; do
    echo "  npm run folder $site"
  done
  echo ""
  echo "  npm run folder          build them all"
  echo "  npm run folder --down   remove them all (leaves the local site alone)"
  exit 0
fi

if [[ " $TEST_SITES " == *" $1 "* ]]; then
  sites up "$1"
  exit 0
fi

FOLDER_NAME="$1"

# Validate folder exists
if [ ! -d "$FOLDERS_DIR/$FOLDER_NAME" ]; then
  echo "Error: Folder '$FOLDER_NAME' not found in $FOLDERS_DIR"
  echo ""
  echo "Available folders:"
  folders=$(get_available_folders)
  while IFS= read -r folder; do
    echo "  npm run folder $folder"
  done <<< "$folders"
  exit 1
fi

# Run nodemon with the folder name as argument
docker exec blot-node-app-1 npx nodemon app/templates/folders --ext '*' --watch "/usr/src/app/app/templates/folders/$FOLDER_NAME" "$FOLDER_NAME"

