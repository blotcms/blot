#!/usr/bin/env bash
set -euo pipefail

# Runs this git worktree in its own Node container on a-local.blot … e-local.blot,
# sharing the main stack's nginx, Redis, data/ and airlock. See worktrees.md.
#
#   scripts/development/preview.sh up     claim a slot (or reuse this worktree's)
#   scripts/development/preview.sh down   release this worktree's slot
#   scripts/development/preview.sh ls     show which worktree holds each slot

SLOTS=(a b c d e)
COMPOSE_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/docker-compose.worktree.yml"
WORKTREE_ROOT="$(git rev-parse --show-toplevel)"
COMMON_GIT_DIR="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
MAIN_ROOT="$(dirname "$COMMON_GIT_DIR")"

compose() {
  local slot="$1"; shift
  SLOT="$slot" WORKTREE_ROOT="$WORKTREE_ROOT" MAIN_ROOT="$MAIN_ROOT" \
    docker compose -f "$COMPOSE_FILE" "$@"
}

# Prints "<slot> <worktree path>" for every existing sidecar container
holders() {
  local slot path
  for slot in "${SLOTS[@]}"; do
    path="$(docker inspect -f '{{index .Config.Labels "blot.worktree"}}' "blot-node-$slot" 2>/dev/null)" || continue
    echo "$slot $path"
  done
}

slot_of_this_worktree() {
  holders | awk -v p="$WORKTREE_ROOT" '$2 == p { print $1 }'
}

up() {
  if [ "$WORKTREE_ROOT" = "$MAIN_ROOT" ]; then
    echo "This is the main checkout; it is already served at https://local.blot" >&2
    exit 1
  fi

  if ! curl -ksf --max-time 5 https://local.blot/health >/dev/null; then
    echo "https://local.blot is not up. Ask the operator to run 'npm start'." >&2
    exit 1
  fi

  local slot
  slot="$(slot_of_this_worktree)"

  if [ -z "$slot" ]; then
    # Reap sidecars whose worktree has been deleted
    local s path
    while read -r s path; do
      if [ ! -d "$path" ]; then
        echo "Removing orphaned blot-node-$s (worktree $path is gone)"
        docker rm -f "blot-node-$s" >/dev/null
      fi
    done < <(holders)

    for s in "${SLOTS[@]}"; do
      if ! docker inspect "blot-node-$s" >/dev/null 2>&1; then slot="$s"; break; fi
    done

    if [ -z "$slot" ]; then
      echo "All five preview slots are in use:" >&2
      ls_slots >&2
      echo "Run 'preview.sh down' from a worktree you are finished with." >&2
      exit 1
    fi
  fi

  compose "$slot" up -d

  local host="$slot-local.blot" i
  for i in $(seq 1 60); do
    if curl -ksf --max-time 3 "https://$host/health" >/dev/null; then break; fi
    sleep 2
  done

  echo
  echo "Slot $slot  ($WORKTREE_ROOT)"
  echo "  Dashboard: https://$host"
  echo "  Blog:      https://<handle>.$host"
  echo "  Container: blot-node-$slot"
  echo "  Login:     docker exec blot-node-$slot node scripts/blog/access.js 'example@example.com'"
}

down() {
  local slot
  slot="$(slot_of_this_worktree)"
  if [ -z "$slot" ]; then
    echo "No preview running for $WORKTREE_ROOT"
    return
  fi
  compose "$slot" down --timeout 0
  echo "Released slot $slot"
}

ls_slots() {
  local slot path any=0
  for slot in "${SLOTS[@]}"; do
    path="$(docker inspect -f '{{index .Config.Labels "blot.worktree"}}' "blot-node-$slot" 2>/dev/null)" || continue
    echo "$slot  https://$slot-local.blot  $path"
    any=1
  done
  [ "$any" = 1 ] || echo "No previews running"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  ls) ls_slots ;;
  *) echo "Usage: $0 up|down|ls" >&2; exit 1 ;;
esac
