#!/bin/bash
# Usage: offsite-sync.sh [--quick | --full]
# Copies the whole storage bucket (blog folders, the git store, generated
# assets) to Backblaze B2, under <b2 bucket>/storage/, with rclone. It is the
# bucket's only backup (README.md, "Offsite backup and restore"). Runs daily as
# ec2-user from blot-storage-offsite.timer (config/host/host/setup.sh); the log
# is ~ec2-user/storage-offsite.log.
#
# It is a sync, but nothing is ever deleted from B2: a file deleted or replaced
# at the source is hidden there (or gets a new version), and the B2 bucket's
# lifecycle rule deletes hidden and old versions 30 days later. The B2 key
# cannot delete. The remotes come from offsite-lib.sh.
#
# Each top-level directory of the bucket (a blog) is synced on its own, a few at
# a time, each with --fast-list: one listing per blog on each side, rather than
# one per directory, while only one blog's listing is ever held in memory.
# A blog gone from the bucket is hidden in B2 the same way, unless more than
# MAX_HIDE of them are, which looks like a broken listing rather than deletions.
#
# Files are compared by size and modification time, never by checksum: S3's
# ETags are MD5s (and not even that for multipart uploads), B2 keeps SHA-1s.
# Daily (--quick, the default) it uses the times S3 lists, with --update, so S3
# needs no HEAD request per object. On Sundays (UTC) and with --full it reads
# each object's time with a HEAD instead, which catches an object rewritten
# while the previous run was copying it.
#
# Off (logs and exits 0) without a bucket in /etc/blot/storage-offsite-bucket,
# so drill hosts and hosts without the key stay inert, as for the Redis
# offsite. It also only runs on the host promote.sh marked active
# (/etc/blot-redis/active), so during a host cycle only one host syncs. On
# success it records "<iso time> <objects> <bytes>" (what B2 now holds) in
# Redis at blot:storage:offsite, which the daily email reads and
# app/scheduler/check-redis-host.js alerts on after 50 hours. On failure it logs
# a WARNING and exits non-zero, and records nothing.
#
# Env, all optional: BLOT_STORAGE_OFFSITE_PARALLEL (blogs at once, default 4),
# BLOT_STORAGE_OFFSITE_BWLIMIT (per blog, rclone's --bwlimit, default 10M, so
# 40 MiB/s at most in all), BLOT_STORAGE_OFFSITE_MAX_HIDE (default 50),
# BLOT_STORAGE_OFFSITE_LOG_LEVEL (rclone's, default NOTICE; INFO lists every
# copy and hide). BLOT_ROOT prefixes paths, for the tests. Written to run under
# sh as well as bash, for the tests.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=offsite-lib.sh
. "$HERE/offsite-lib.sh"

PARALLEL=${BLOT_STORAGE_OFFSITE_PARALLEL:-4}
BWLIMIT=${BLOT_STORAGE_OFFSITE_BWLIMIT:-10M}
MAX_HIDE=${BLOT_STORAGE_OFFSITE_MAX_HIDE:-50}
LOG_LEVEL=${BLOT_STORAGE_OFFSITE_LOG_LEVEL:-NOTICE}

MODE=quick
case "${1:-}" in
  "") [ "$(date -u +%u)" != 7 ] || MODE=full ;;
  --quick) ;;
  --full) MODE=full ;;
  *) echo "usage: offsite-sync.sh [--quick | --full]" >&2; exit 2 ;;
esac

log() { echo "[$(date +%Y-%m-%d-%H-%M-%S)] storage offsite: $*"; }

if [ -e "$ROOT/etc/blot/drill" ] || [ -e "$ROOT/etc/blot-redis/drill" ]; then
  log "skipped: drill host"; exit 0
fi
if [ -z "$(offsite_bucket)" ]; then
  log "off (no bucket in /etc/blot/storage-offsite-bucket)"; exit 0
fi
if [ ! -e "$ROOT/etc/blot-redis/active" ]; then
  log "skipped: not marked as the active host (/etc/blot-redis/active)"; exit 0
fi

# One at a time: a run by hand and the timer's must not overlap.
exec 9> "$ROOT/tmp/blot-storage-offsite.lock"
flock -n 9 || { log "skipped: another sync is still running"; exit 0; }

WORK=$(mktemp -d "${TMPDIR:-/tmp}/blot-storage-offsite.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
START=$(date +%s)

if ! setup_remotes > "$WORK/setup"; then
  log "WARNING: $(cat "$WORK/setup")"; exit 1
fi

# rclone's own retries cover a failed request; a blog that still fails is
# retried by the next run.
FLAGS="--fast-list --transfers 4 --checkers 8 --bwlimit $BWLIMIT --retries 3 --low-level-retries 10 --stats 0 --log-level $LOG_LEVEL"
if [ "$MODE" = quick ]; then
  SYNC_FLAGS="$FLAGS --update --use-server-modtime"
else
  SYNC_FLAGS=$FLAGS
fi

# The top level of each side: one directory per blog ("blog_.../").
if ! rclone lsf --dirs-only --max-depth 1 "storage:$STORAGE_BUCKET" > "$WORK/source" 2> "$WORK/list-error"; then
  log "WARNING: could not list the storage bucket: $(head -c 300 "$WORK/list-error")"; exit 1
fi
if [ ! -s "$WORK/source" ]; then
  log "WARNING: the storage bucket lists no directories; refusing to sync"; exit 1
fi
# On the first run there is nothing there yet, which rclone calls an error.
rclone lsf --dirs-only --max-depth 1 "$OFFSITE_ROOT" > "$WORK/offsite" 2> /dev/null || : > "$WORK/offsite"
grep -vxF -f "$WORK/source" "$WORK/offsite" > "$WORK/gone" || true

sed 's/^/sync /' "$WORK/source" > "$WORK/jobs"
gone=$(wc -l < "$WORK/gone" | tr -d ' ')
too_many_gone=
if [ "$gone" -gt "$MAX_HIDE" ]; then
  log "WARNING: $gone blogs are in B2 but not in the bucket, more than $MAX_HIDE: hiding none of them. If they were deleted, rerun with BLOT_STORAGE_OFFSITE_MAX_HIDE=$gone"
  too_many_gone=1
else
  sed 's/^/hide /' "$WORK/gone" >> "$WORK/jobs"
fi
log "$MODE sync of $(wc -l < "$WORK/source" | tr -d ' ') blogs to B2 ($gone gone from the bucket), $PARALLEL at a time"

# worker <n>: runs the jobs in $WORK/jobs.<n>. A blog that fails is listed in
# $WORK/failed.<n>, and what B2 holds of each synced one in $WORK/sizes.<n>.
worker() {
  done_count=0
  while read -r action dir; do
    d=${dir%/}
    done_count=$((done_count + 1))
    [ $((done_count % 1000)) != 0 ] || log "worker $1: $done_count blogs done"
    if [ "$action" = hide ]; then
      # rclone's B2 delete hides each file (hard_delete is off).
      # shellcheck disable=SC2086
      if rclone delete $FLAGS "$OFFSITE_ROOT/$d" 2>&1 | awk -v p="$d: " '{ print p $0 }'; then
        log "hid $d, gone from the bucket"
      else
        echo "$d" >> "$WORK/failed.$1"
      fi
      continue
    fi
    # Two passes, manifests last. The git store (app/clients/git/store,
    # layout.js) uploads a push's packs before the manifest that names them,
    # {blogID}/git/manifests/<seq>.json (and latest.json), but rclone copies
    # keys in no particular order, so one pass could copy a new manifest
    # while its packs are still missing from B2. Everything else first, then
    # the manifests, so every manifest in B2 names packs already there. Each
    # pass syncs, and hides deletions, only within its own filter.
    # shellcheck disable=SC2086
    if rclone sync $SYNC_FLAGS --exclude "/git/manifests/**" "storage:$STORAGE_BUCKET/$d" "$OFFSITE_ROOT/$d" 2>&1 | awk -v p="$d: " '{ print p $0 }' &&
      rclone sync $SYNC_FLAGS --include "/git/manifests/**" "storage:$STORAGE_BUCKET/$d" "$OFFSITE_ROOT/$d" 2>&1 | awk -v p="$d: " '{ print p $0 }' &&
      size=$(rclone size --fast-list --json "$OFFSITE_ROOT/$d" 2> /dev/null); then
      count=$(echo "$size" | sed -n 's/.*"count": *\([0-9]*\).*/\1/p')
      bytes=$(echo "$size" | sed -n 's/.*"bytes": *\([0-9]*\).*/\1/p')
      echo "${count:-0} ${bytes:-0}" >> "$WORK/sizes.$1"
    else
      echo "$d" >> "$WORK/failed.$1"
    fi
  done < "$WORK/jobs.$1"
}

awk -v n="$PARALLEL" -v w="$WORK" '{ print > (w "/jobs." (NR % n)) }' "$WORK/jobs"
for jobs in "$WORK"/jobs.*; do
  worker "${jobs##*.}" &
done
wait

# Each file exists only if its worker had something to write.
touch "$WORK/failed.x" "$WORK/sizes.x"
failures=$(cat "$WORK"/failed.* | wc -l | tr -d ' ')
read -r objects bytes << EOF
$(cat "$WORK"/sizes.* | awk '{ c += $1; b += $2 } END { printf "%.0f %.0f\n", c, b }')
EOF
elapsed=$(( $(date +%s) - START ))

if [ "$failures" -gt 0 ]; then
  log "WARNING: $failures blogs failed after ${elapsed}s, so this run is not recorded: $(cat "$WORK"/failed.* | head -n 5 | tr '\n' ' ')"
  exit 1
fi
if [ -n "$too_many_gone" ]; then
  log "WARNING: synced in ${elapsed}s but hid nothing (above), so this run is not recorded"
  exit 1
fi

# Best effort, like backup.sh's: the copy is done either way, and a missing
# record shows in the daily email after 2 days.
TIMEOUT=$(command -v timeout > /dev/null && echo "timeout 10" || true)
$TIMEOUT redis6-cli SET "$OFFSITE_REDIS_KEY" "$(date -u +%Y-%m-%dT%H:%M:%SZ) $objects $bytes" > /dev/null 2>&1 ||
  log "WARNING: could not record the sync in Redis"
log "done in ${elapsed}s: B2 holds $objects objects, $bytes bytes"
