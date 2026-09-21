#!/usr/bin/env bash
set -euo pipefail

# Runs this git worktree in its own Node container on a-local.blot … e-local.blot,
# sharing the main stack's nginx, Redis, data/ and airlock. See worktrees.md.
#
#   scripts/development/preview.sh up [url-or-path]
#                                         claim a slot (or reuse this worktree's) and print
#                                         a dashboard login URL plus a direct URL to the
#                                         work; give it the page being worked on, as a
#                                         path (/sites/local) or a local.blot URL
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
  local target="${1:-}"
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
    # Ask the sidecar itself: until nginx routes the slot, $host would hit the main stack
    if docker exec "blot-node-$slot" node -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then break; fi
    sleep 2
  done

  # The slot block lives in development_server.conf, which the main stack's nginx
  # mounts from the main checkout. Without it, <slot>-local.blot shows "no site here".
  if ! docker exec blot-nginx-1 grep -q preview_upstream /etc/nginx/nginx.conf 2>/dev/null; then
    echo "WARNING: the running nginx has no preview routing, so https://$host will not reach this sidecar." >&2
    echo "  Update the main checkout to a commit containing config/openresty/development_server.conf's" >&2
    echo "  preview block, then: docker compose -f $MAIN_ROOT/scripts/development/docker-compose.yml restart nginx" >&2
  fi

  local login work
  login="$(docker exec "blot-node-$slot" node scripts/blog/access.js example@example.com 2>/dev/null | grep -m1 '^https://')" || true

  case "$target" in
    "") work="" ;;
    http*) work="$(echo "$target" | sed -E "s#^(https?://[^/]*)local\.blot#\1$host#")" ;;
    /*) work="https://$host$target" ;;
    *) work="https://$host/$target" ;;
  esac

  echo
  echo "Slot $slot  ($WORKTREE_ROOT)"
  echo "  Login (one-time, opens dashboard): ${login:-failed; run: docker exec blot-node-$slot node scripts/blog/access.js example@example.com}"
  echo "  Work:      ${work:-none given; pass a URL or path, e.g. up /sites/local}"
  echo "  Dashboard: https://$host/sites"
  echo "  Blogs:     https://<handle>.$host"
  echo "  Container: blot-node-$slot"
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
  up) shift; up "$@" ;;
  down) down ;;
  ls) ls_slots ;;
  *) echo "Usage: $0 up|down|ls" >&2; exit 1 ;;
esac
