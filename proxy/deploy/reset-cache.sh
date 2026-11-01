#!/usr/bin/env bash
#
# Empties the disk cache every unit on this host shares, while they run:
#
#   proxy/deploy/reset-cache.sh <commit-sha | image>
#
# blue-green.sh does this itself when nothing is running. config/host/cycle.sh
# needs it at the switch: the new host's cache was filled during verification
# and missed every purge since, and cached pages have no TTL. nginx treats a
# cached file that has gone as a miss. <image> only supplies sh and rm, so use
# one already on the host. See reset_cache_dir in common.sh.
set -euo pipefail

IMAGE="${1:?usage: reset-cache.sh <commit-sha | image>}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$DIR/common.sh"

IMAGE="$(resolve_image "$IMAGE")"
[ -d "$DISK_CACHE_DIR" ] || die "cache directory $DISK_CACHE_DIR does not exist"
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "$IMAGE is not on this host"
acquire_lock
reset_cache_dir "$DISK_CACHE_DIR" "$IMAGE" || die "cannot empty $DISK_CACHE_DIR"
log "Emptied $DISK_CACHE_DIR"
