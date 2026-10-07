#!/bin/bash
# Usage: restore.sh [--yes] [--reference HOST[:PORT]] <ssh-host> latest|<backup-name>|list
# Restores a Redis backup from s3://blot-redis-backups onto <ssh-host>:
# downloads it on the host, checks it with redis-check-rdb, then stops Redis,
# swaps in the file and starts Redis again. This REPLACES the host's data, so it
# asks first (--yes skips that). <backup-name> is e.g. 2026-10-07-hour-13 or
# hourly/2026-10-07-hour-13; "list" shows what is available. --reference gives
# another Redis host (reachable from <ssh-host>) to compare DBSIZE and keyspace
# with afterwards. The host needs AWS credentials (instance profile or ~/.aws).
set -euo pipefail
. "$(dirname "$0")/lib.sh"

BUCKET=blot-redis-backups
ASSUME_YES=""
REFERENCE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) ASSUME_YES=1; shift ;;
    --reference) [ $# -ge 2 ] || die "--reference needs a host"; REFERENCE=$2; shift 2 ;;
    -*) die "unknown option $1" ;;
    *) break ;;
  esac
done
[ $# -eq 2 ] || die "usage: restore.sh [--yes] [--reference HOST[:PORT]] <ssh-host> latest|<backup-name>|list"
HOST=$1
WHICH=$2
case "$WHICH$REFERENCE" in *[!A-Za-z0-9._:/-]*) die "unexpected characters in arguments" ;; esac

# Every backup in the bucket, oldest first: "<date> <time> <size> <key>".
listing=$(ssh_run "$HOST" "aws s3 ls --recursive s3://$BUCKET/ | sort") || die "could not list s3://$BUCKET (does $HOST have AWS credentials?)"
listing=$(echo "$listing" | grep -E ' (hourly|daily)/.*\.rdb$' || true)
[ -n "$listing" ] || die "no backups found in s3://$BUCKET"

if [ "$WHICH" = list ]; then
  echo "$listing"
  exit 0
fi

if [ "$WHICH" = latest ]; then
  KEY=$(echo "$listing" | tail -n 1 | awk '{print $4}')
else
  # Accept "NAME", "NAME.rdb", "hourly/NAME" or "daily/NAME"; if a bare name is in both folders take the newer.
  name=${WHICH%.rdb}
  KEY=$(echo "$listing" | awk '{print $4}' | grep -E "(^|/)$name\.rdb\$" | tail -n 1 || true)
  [ -n "$KEY" ] || die "no backup called $WHICH (try: restore.sh $HOST list)"
fi
echo "$KEY" | grep -qE '^(hourly|daily)/[A-Za-z0-9._-]+\.rdb$' || die "unexpected backup key: $KEY"
echo "Backup: s3://$BUCKET/$KEY"

# The target must be ready, and must not be using AOF (it would load that
# instead of the RDB we are about to put in place).
[ "$(ssh_run "$HOST" "redis6-cli CONFIG GET appendonly | tail -n 1")" = no ] ||
  die "appendonly is on (or Redis is unreachable) on $HOST; refusing to restore"
before=$(ssh_run "$HOST" "redis6-cli DBSIZE")
echo "Current data on $HOST: $before"
if [ -z "$ASSUME_YES" ]; then
  read -r -p "Replace it with $KEY? [y/N] " reply
  case "$reply" in y | Y | yes) ;; *) die "aborted" ;; esac
fi

# Download as the login user (that is who has the AWS credentials) onto the
# instance store if present, then verify before touching Redis. The package's
# redis6-check-rdb does not work: Redis picks its mode from the program name,
# which must contain "redis-check-rdb", so check through a link named that.
echo "Downloading and checking the backup on $HOST"
FILE=$(ssh_run "$HOST" "
  set -euo pipefail
  dir=/var/tmp; mountpoint -q /backups && dir=/backups
  f=\$dir/restore-\$(basename $KEY)
  aws s3 cp --only-show-errors s3://$BUCKET/$KEY \$f
  link=\$(mktemp -d)/redis-check-rdb
  ln -s /usr/bin/redis6-server \$link
  \$link \$f > /dev/null
  echo \$f
") || die "download or RDB check failed"
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
