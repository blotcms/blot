#!/bin/bash
# Usage: restore.sh [--yes] [--reference HOST[:PORT]] [--offsite <read-profile> <s3://bucket>]
#                   <ssh-host> latest|<backup-name>|list
# Restores a Redis backup from s3://blot-redis-backups onto <ssh-host>:
# downloads it on the host, checks it with redis-check-rdb, then stops Redis,
# swaps in the file and starts Redis again. This REPLACES the host's data, so it
# asks first (--yes skips that). <backup-name> is e.g. 2026-10-07-hour-13 or
# hourly/2026-10-07-hour-13; "list" shows what is available. --reference gives
# another Redis host (reachable from <ssh-host>) to compare DBSIZE and keyspace
# with afterwards. The host needs AWS credentials (instance profile or ~/.aws).
#
# --offsite restores from the Backblaze B2 bucket instead (daily/ backups only),
# for when AWS is unavailable. <read-profile> is an AWS CLI profile on THIS
# machine with the B2 read key; <s3://bucket> is the B2 bucket (its name is in
# /etc/blot-redis/offsite-bucket on the Redis host). This machine lists and
# downloads the backup, then streams it to the host over ssh, so it needs the
# disk space for one backup and the host needs no AWS or B2 credentials.
# Example: restore.sh --offsite blot-b2-read s3://example <ssh-host> latest
set -euo pipefail
. "$(dirname "$0")/lib.sh"

BUCKET=blot-redis-backups
ASSUME_YES=""
REFERENCE=""
OFFSITE_PROFILE=""
OFFSITE_BUCKET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) ASSUME_YES=1; shift ;;
    --reference) [ $# -ge 2 ] || die "--reference needs a host"; REFERENCE=$2; shift 2 ;;
    --offsite)
      [ $# -ge 3 ] || die "--offsite needs a read profile and an s3://bucket"
      OFFSITE_PROFILE=$2; OFFSITE_BUCKET=$3; shift 3 ;;
    -*) die "unknown option $1" ;;
    *) break ;;
  esac
done
[ $# -eq 2 ] || die "usage: restore.sh [--yes] [--reference HOST[:PORT]] [--offsite <read-profile> <s3://bucket>] <ssh-host> latest|<backup-name>|list"
HOST=$1
WHICH=$2
case "$WHICH$REFERENCE" in *[!A-Za-z0-9._:/-]*) die "unexpected characters in arguments" ;; esac
if [ -n "$OFFSITE_BUCKET" ]; then
  case "$OFFSITE_PROFILE" in '' | *[!A-Za-z0-9._-]*) die "unexpected characters in the --offsite profile" ;; esac
  case "$OFFSITE_BUCKET" in s3://*) ;; *) die "--offsite needs an s3://bucket, got $OFFSITE_BUCKET" ;; esac
  case "${OFFSITE_BUCKET#s3://}" in '' | *[!A-Za-z0-9._-]*) die "unexpected characters in the --offsite bucket" ;; esac
  SOURCE=$OFFSITE_BUCKET
else
  SOURCE=s3://$BUCKET
fi

# Every backup in the bucket, oldest first: "<date> <time> <size> <key>". The
# offsite listing runs here with the B2 read key; the S3 one runs on the host.
if [ -n "$OFFSITE_BUCKET" ]; then
  listing=$(aws --profile "$OFFSITE_PROFILE" s3 ls --recursive "$SOURCE/" | sort) || die "could not list $SOURCE with profile $OFFSITE_PROFILE"
else
  listing=$(ssh_run "$HOST" "aws s3 ls --recursive $SOURCE/ | sort") || die "could not list $SOURCE (does $HOST have AWS credentials?)"
fi
listing=$(echo "$listing" | grep -E ' (hourly|daily|weekly)/.*\.rdb$' || true)
[ -n "$listing" ] || die "no backups found in $SOURCE"

if [ "$WHICH" = list ]; then
  echo "$listing"
  exit 0
fi

if [ "$WHICH" = latest ]; then
  KEY=$(echo "$listing" | tail -n 1 | awk '{print $4}')
else
  # Accept "NAME", "NAME.rdb", "hourly/NAME", "daily/NAME" or "weekly/NAME"; if a bare name is in both folders take the newer.
  name=${WHICH%.rdb}
  KEY=$(echo "$listing" | awk '{print $4}' | grep -E "(^|/)$name\.rdb\$" | tail -n 1 || true)
  [ -n "$KEY" ] || die "no backup called $WHICH (try: restore.sh $HOST list)"
fi
echo "$KEY" | grep -qE '^(hourly|daily|weekly)/[A-Za-z0-9._-]+\.rdb$' || die "unexpected backup key: $KEY"
echo "Backup: $SOURCE/$KEY"

# The target must be ready, and must not be using AOF (it would load that
# instead of the RDB we are about to put in place).
[ "$(ssh_run "$HOST" "redis6-cli CONFIG GET appendonly | tail -n 1")" = no ] ||
  die "appendonly is on (or Redis is unreachable) on $HOST; refusing to restore"
before=$(ssh_run "$HOST" "redis6-cli DBSIZE")
echo "Current data on $HOST: $before"
if [ -z "$ASSUME_YES" ]; then
  read -r -p "Replace it with $KEY? [y/N] " reply || die "no answer (use --yes when not running interactively)"
  case "$reply" in y | Y | yes) ;; *) die "aborted" ;; esac
fi

# Get the file onto the host, onto the instance store if present. S3: the host
# downloads it as the login user (who has the AWS credentials). Offsite: this
# machine downloads it (the B2 key never goes to a server) and streams it over.
echo "Fetching the backup onto $HOST"
if [ -n "$OFFSITE_BUCKET" ]; then
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  aws --profile "$OFFSITE_PROFILE" s3 cp --only-show-errors "$SOURCE/$KEY" "$tmp/backup.rdb" || die "download from $SOURCE failed"
  FILE=$(ssh_run "$HOST" "dir=/var/tmp; mountpoint -q /backups && dir=/backups; echo \$dir/restore-$(basename "$KEY")")
  ssh_run "$HOST" "cat > $FILE" < "$tmp/backup.rdb" || { ssh_run "$HOST" "rm -f $FILE" || true; die "could not copy the backup to $HOST"; }
else
  FILE=$(ssh_run "$HOST" "
    set -euo pipefail
    dir=/var/tmp; mountpoint -q /backups && dir=/backups
    f=\$dir/restore-\$(basename $KEY)
    aws s3 cp --only-show-errors $SOURCE/$KEY \$f
    echo \$f
  ") || die "download failed"
fi

# Verify before touching Redis, and never leave a bad file behind. The package's
# redis6-check-rdb does not work: Redis picks its mode from the program name,
# which must contain "redis-check-rdb", so check through a link named that.
ssh_run "$HOST" "
  set -euo pipefail
  tmp=\$(mktemp -d); trap 'rm -rf \$tmp' EXIT
  ln -s /usr/bin/redis6-server \$tmp/redis-check-rdb
  \$tmp/redis-check-rdb '$FILE' > /dev/null || { rm -f '$FILE'; exit 1; }
" || die "RDB check failed"
echo "Backup passed the RDB check: $FILE"

# Stage next to the data file first, so the swap itself is a quick rename.
echo "Swapping it in (Redis is down while this runs)"
ssh_run "$HOST" "sudo bash -s" <<REMOTE
set -euo pipefail
install -o redis6 -g redis6 -m 0644 '$FILE' /var/lib/redis6/dump.rdb.restoring
systemctl stop redis6
mv -f /var/lib/redis6/dump.rdb.restoring /var/lib/redis6/dump.rdb
systemctl start redis6
rm -f '$FILE'
REMOTE

echo "Waiting for Redis to finish loading"
ssh_run "$HOST" '
  for _ in $(seq 1 600); do
    redis6-cli INFO persistence 2> /dev/null | tr -d "\r" | grep -qx "loading:0" && exit 0
    sleep 2
  done
  echo "Redis did not finish loading in 20 minutes" >&2
  exit 1
' || die "Redis on $HOST did not come back"

echo "Restored. On $HOST:"
ssh_run "$HOST" 'echo "  DBSIZE $(redis6-cli DBSIZE)"; redis6-cli INFO keyspace | tr -d "\r" | sed "s/^/  /"'

if [ -n "$REFERENCE" ]; then
  ref_host=${REFERENCE%%:*}
  ref_port=6379
  case "$REFERENCE" in *:*) ref_port=${REFERENCE##*:} ;; esac
  echo "Reference $REFERENCE (live, so expect it to be slightly ahead of the backup):"
  ssh_run "$HOST" "redis6-cli -h $ref_host -p $ref_port DBSIZE; redis6-cli -h $ref_host -p $ref_port INFO keyspace | tr -d '\r'" |
    sed 's/^/  /'
fi
