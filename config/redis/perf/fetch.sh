#!/bin/bash
# Usage: fetch.sh [--since <docker-duration>] [--no-app-logs] <redis-ssh-host> <app-ssh-host>
# Copies the collector logs from ~/perf on both hosts into
# data/redis-perf/<host>/ in the repo (data/ is gitignored), ready for
# compare.js. It overwrites the previous copy, so run it as often as you like.
#
# It also counts the app's "[LOCK] slow heartbeat" and "[LOCK COMPROMISED]" lines
# per minute from the app containers' docker logs (blot-container-blue, -green and
# -yellow; the same lines the investigate-production-container-restarts skill
# reads) and writes them to data/redis-perf/<app-host>/app-lock.log, one line
# per container per minute that had any. --since is how far back to look (a
# `docker logs --since` value, default 7d). docker logs only go back to when each
# container was created, so a deploy during the test cuts them short: fetch
# before deploying. Only read-only commands are run on the hosts.
#
# SSH_OPTS / APP_SSH_OPTS: see common.sh. FETCH_OUT overrides the output directory.
set -euo pipefail
. "$(dirname "$0")/common.sh"

SINCE=7d
APP_LOGS=1
while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE=${2:?--since needs a value}; shift 2 ;;
    --no-app-logs) APP_LOGS=0; shift ;;
    -*) die "unknown option $1" ;;
    *) break ;;
  esac
done
[ $# -eq 2 ] || die "usage: fetch.sh [--since 7d] [--no-app-logs] <redis-ssh-host> <app-ssh-host>"
REDIS_HOST=$1
APP_HOST=$2
case "$SINCE" in *[!0-9a-z]* | "") die "--since must look like 24h or 7d" ;; esac

REPO=$(cd "$PERF_DIR_LOCAL/../../.." && pwd)
OUT=${FETCH_OUT:-$REPO/data/redis-perf}

# fetch_logs <ssh-fn> <host>: tar up the logs in ~/perf and unpack them locally.
fetch_logs() {
  local ssh=$1 host=$2
  mkdir -p "$OUT/$host"
  $ssh "$host" 'cd ~/perf && ls *.log *.log.1 2> /dev/null | tar -czf - -T -' | tar -xzf - -C "$OUT/$host" ||
    die "no logs fetched from $host (is ~/perf/*.log there? did install.sh run?)"
  echo "$host: $(cd "$OUT/$host" && wc -l ./*.log | awk '$2 != "total" {sub("^\\./", "", $2); printf "%s (%s lines)  ", $2, $1}')"
}

fetch_logs ssh_run "$REDIS_HOST"
fetch_logs app_ssh "$APP_HOST"

if [ "$APP_LOGS" = 1 ]; then
  echo "$APP_HOST: counting [LOCK] lines in the app containers' logs (since $SINCE)"
  # -t puts a UTC timestamp at the start of each line; the first 16 characters
  # are the minute. The count is done on the host so only a few lines come back.
  app_ssh "$APP_HOST" "for c in blue green yellow; do
    docker logs -t --since $SINCE blot-container-\$c 2>&1 |
      grep -F -e '[LOCK] slow heartbeat' -e '[LOCK COMPROMISED]' |
      awk -v c=\$c '{ m = substr(\$1, 1, 16) \":00Z\"; seen[m] = 1
        if (index(\$0, \"[LOCK COMPROMISED]\")) k[m]++; else s[m]++ }
        END { for (m in seen) printf \"%s container=%s slow=%d compromised=%d\\n\", m, c, s[m] + 0, k[m] + 0 }'
  done | sort" > "$OUT/$APP_HOST/app-lock.log" ||
    echo "warning: could not read the app container logs; the lock counts will be missing" >&2
  echo "$APP_HOST: app-lock.log ($(wc -l < "$OUT/$APP_HOST/app-lock.log" | tr -d ' ') lines)"
fi

echo "Logs are in $OUT"
