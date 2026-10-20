#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../../.." && pwd)"
export BLOT_HOST="${BLOT_HOST:-local.blot}"
BASE=(-f "$ROOT/scripts/development/docker-compose.yml")
EXTRA=()
# Optional machine-specific mounts/build secrets, kept outside tracked config.
if [ -n "${AGENTATION_COMPOSE_OVERRIDE:-}" ]; then
  EXTRA=(-f "$AGENTATION_COMPOSE_OVERRIDE")
fi
compose() {
  docker compose "${BASE[@]}" -f "$DIR/compose.yml" "${EXTRA[@]}" "$@"
}
check_codex() {
  if ! command -v codex >/dev/null 2>&1; then
    echo "[agentation] Codex CLI is required. Install it, then register Agentation:" >&2
  elif codex mcp list --json | node "$DIR/check-codex.mjs" "$DIR/run.sh"; then
    return 0
  else
    echo "[agentation] Codex needs an enabled Agentation MCP entry pointing to this checkout." >&2
  fi
  printf '\n  codex mcp add agentation -- bash %q mcp\n\n' "$DIR/run.sh" >&2
  echo "[agentation] Run this command (again if the checkout moved), restart Codex, then retry npm start." >&2
  return 1
}
case "${1:-}" in
  check)
    check_codex
    ;;
  up)
    check_codex
    node "$DIR/generate-config.mjs"
    compose build agentation
    # Copy out the asset without mounting over the image's build output.
    mkdir -p "$DIR/generated/dist"
    compose run --rm --no-deps -T --entrypoint cat agentation /opt/agentation/dist/toolbar.js > "$DIR/generated/dist/toolbar.js"
    # Nginx workers must be able to read the asset even with a host umask of 077.
    chmod 755 "$DIR/generated/dist"
    chmod 644 "$DIR/generated/dist/toolbar.js"
    compose up -d --no-deps --wait agentation
    compose up -d --no-deps --force-recreate nginx
    ;;
  down)
    # Restore the original proxy mount, leaving the app and annotation volume.
    docker compose "${BASE[@]}" "${EXTRA[@]}" up -d --no-deps --force-recreate nginx
    compose stop agentation
    ;;
  mcp)
    # No TTY, status banners or build output on MCP's stdout.
    exec docker compose "${BASE[@]}" -f "$DIR/compose.yml" "${EXTRA[@]}" \
      run --rm --no-deps -T --entrypoint /opt/agentation/node_modules/.bin/agentation-mcp \
      agentation server --mcp-only --http-url http://agentation:8477
    ;;
  *) echo "Usage: $0 {check|up|down|mcp}" >&2; exit 1 ;;
esac
