#!/bin/bash
# Usage: backup.sh hourly|daily
# Copies Redis's RDB snapshot to /backups and uploads it to
# s3://blot-redis-backups/<hourly|daily>/<YYYY-MM-DD-hour-HH>.rdb, then prunes
# old copies. Runs as ec2-user from /etc/cron.d/blot-redis (hourly at :00, daily
# at 03:05) and uses whatever AWS credentials that user has (instance profile
# or ~/.aws). After an upload it records it in Redis at blot:redis-host:backup,
# which the app's daily email reads. BLOT_ROOT prefixes paths, for the tests.
set -euo pipefail

KIND=${1:?usage: backup.sh hourly|daily}
BUCKET=${BLOT_BACKUP_BUCKET:-s3://blot-redis-backups}
ROOT=${BLOT_ROOT:-}
RDB=$ROOT/var/lib/redis6/dump.rdb
LOCAL=$ROOT/backups
FLOATING_IP=$ROOT/etc/blot-redis/floating-ip
MAX_SNAPSHOT_AGE=900 # seconds; older than this and we save first
NAME=$(date +%Y-%m-%d-hour-%H)

# How many to keep in S3. Local copies (hourly and daily share them) are
# pruned to the 10 newest.
case "$KIND" in
  hourly) KEEP=6 ;;
  daily) KEEP=7 ;;
  *) echo "usage: backup.sh hourly|daily" >&2; exit 2 ;;
esac

log() { echo "[$(date +%Y-%m-%d-%H-%M-%S)] $KIND backup: $*"; }

# A drill host (launch.sh --drill) holds a copy of production data and may be
# put through a real cutover, which marks it active below. It must never upload
# to (or prune) the production bucket.
if [ -e "$ROOT/etc/blot-redis/drill" ]; then
  log "skipped: drill host (/etc/blot-redis/drill)"; exit 0
fi
redis() { redis6-cli "$@" | tr -d '\r'; }
field() { redis INFO "$1" | awk -F: -v k="$2" '$1 == k {print $2}'; }

# One backup at a time, so the daily never races an hourly that is still running.
exec 9> "$ROOT/tmp/blot-redis-backup.lock"
flock -w 900 9 || { log "another backup is still running"; exit 1; }

# Fail loudly (rather than "skip") if Redis is down.
redis6-cli INFO server > /dev/null || { log "cannot reach Redis"; exit 1; }

# Only the current master uploads. During a host swap the old and new host both
# run this; they must never both write to the bucket.
if [ "$(field replication role)" != "master" ]; then
  log "skipped: this host is not a master"; exit 0
fi
min_replicas=$(redis CONFIG GET min-replicas-to-write | tail -n 1)
if [ "$min_replicas" -gt 0 ] && [ "$(field replication min_slaves_good_slaves)" -lt "$min_replicas" ]; then
  log "skipped: writes are refused (min-replicas-to-write)"; exit 0
fi
# A freshly launched or restored host is also a writable master, so being one
# is not enough: the active host is marked with the floating IP clients use,
# written at cutover, and must currently hold it.
if [ ! -s "$FLOATING_IP" ]; then
  log "skipped: not marked as the active host (/etc/blot-redis/floating-ip)"; exit 0
fi
ip=$(tr -d '[:space:]' < "$FLOATING_IP")
if ! "$ROOT/usr/sbin/ip" -4 -o addr show | awk '{print $4}' | cut -d/ -f1 | grep -qx "$ip"; then
  log "skipped: floating IP $ip is not on this host"; exit 0
fi

# Make sure the snapshot is fresh. On a busy instance Redis saves every few
# minutes anyway; this covers a quiet one.
if [ "$(field persistence loading)" != 0 ]; then
  log "skipped: Redis is still loading"; exit 1
fi
if [ $(( $(date +%s) - $(redis LASTSAVE) )) -gt "$MAX_SNAPSHOT_AGE" ]; then
  log "last save is older than ${MAX_SNAPSHOT_AGE}s, running BGSAVE"
  [ "$(field persistence rdb_bgsave_in_progress)" = 1 ] || redis BGSAVE > /dev/null
  for _ in $(seq 1 360); do
    [ "$(field persistence rdb_bgsave_in_progress)" = 1 ] || break
    sleep 5
  done
  [ "$(field persistence rdb_bgsave_in_progress)" = 0 ] || { log "BGSAVE still running after 30 minutes"; exit 1; }
  [ "$(field persistence rdb_last_bgsave_status)" = ok ] || { log "BGSAVE failed"; exit 1; }
fi

# Copy the RDB to the instance store (50MB/s, to go easy on Redis), then upload
# from the copy so a save landing mid-upload cannot change it. If the instance
# store is missing, upload straight from Redis's file.
SOURCE=$RDB
if mountpoint -q "$LOCAL"; then
  log "copying $RDB to $LOCAL/$NAME"
  mkdir -p "$LOCAL/.tmp/$NAME"
  rsync --bwlimit=50000 "$RDB" "$LOCAL/.tmp/$NAME/dump.rdb"
  rm -rf "${LOCAL:?}/$NAME"
  mv "$LOCAL/.tmp/$NAME" "$LOCAL/$NAME"
  SOURCE=$LOCAL/$NAME/dump.rdb
else
  log "WARNING: $LOCAL is not mounted, uploading without a local copy"
fi

log "uploading to $BUCKET/$KIND/$NAME.rdb"
aws s3 cp --only-show-errors "$SOURCE" "$BUCKET/$KIND/$NAME.rdb"

# Record it for the app: "<time> <kind> <s3 key> <bytes>", no TTL. Best effort
# like tcpmem-log.sh's SET: a failure here never fails the backup, and cron
# has nowhere to send errors (it goes in backup.log instead).
bytes=$(wc -c < "$SOURCE" 2> /dev/null | tr -d '[:space:]') || bytes=
TIMEOUT=$(command -v timeout > /dev/null && echo "timeout 10" || true)
$TIMEOUT redis6-cli SET blot:redis-host:backup \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ) $KIND $KIND/$NAME.rdb ${bytes:-0}" > /dev/null 2>&1 ||
  log "WARNING: could not record the backup in Redis"

# Names sort chronologically, so everything after the newest $KEEP is old.
log "pruning $BUCKET/$KIND"
aws s3 ls "$BUCKET/$KIND/" | awk '{print $4}' | sort -r | tail -n +$((KEEP + 1)) |
  while read -r old; do aws s3 rm --only-show-errors "$BUCKET/$KIND/$old"; done

if mountpoint -q "$LOCAL"; then
  for old in $(ls -d "$LOCAL"/20??-??-??-hour-?? | sort -r | tail -n +11); do rm -rf "$old"; done
fi
log "done"
