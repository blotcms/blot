#!/bin/bash
# Usage: install.sh <redis-ssh-host> <app-ssh-host> <redis-private-ip>
#        install.sh --uninstall <redis-ssh-host> <app-ssh-host>
# Installs the Redis performance collectors (README.md) on both hosts:
#   Redis host: redis-sample.sh and a latency probe against 127.0.0.1
#   app host:   a latency probe against <redis-private-ip>:6379
# It copies the scripts to ~/perf/, checks the prerequisites (python3, flock,
# timeout, crontab, and redis6-cli on the Redis host) before changing anything,
# adds crontab lines tagged "# blot-perf" for the ssh user (every other entry is
# left alone; the old crontab is saved to ~/perf/crontab.bak.<ts> first), then
# runs each collector once by hand and prints what it logged. Re-running it
# replaces its own lines rather than duplicating them. --uninstall removes only
# the "# blot-perf" lines and leaves ~/perf and its logs in place.
#
# SSH_OPTS (see ../lib.sh) applies to both hosts; APP_SSH_OPTS, if set, replaces
# it for the app host. Either host can also be a ~/.ssh/config alias.
set -euo pipefail
. "$(dirname "$0")/common.sh"

# valid_ipv4 <string>: exactly four dot-separated octets, 0-255 (bash 3.2).
valid_ipv4() {
  local IFS=. o n=0
  case "$1" in *[!0-9.]* | "" | .* | *. | *..*) return 1 ;; esac
  # shellcheck disable=SC2086  # split on the dots
  for o in $1; do
    n=$((n + 1))
    [ "${#o}" -le 3 ] && [ "$o" -le 255 ] || return 1
  done
  [ "$n" -eq 4 ]
}

UNINSTALL=0
if [ "${1:-}" = "--uninstall" ]; then UNINSTALL=1; shift; fi
if [ "$UNINSTALL" = 1 ]; then
  [ $# -eq 2 ] || die "usage: install.sh --uninstall <redis-ssh-host> <app-ssh-host>"
else
  [ $# -eq 3 ] || die "usage: install.sh <redis-ssh-host> <app-ssh-host> <redis-private-ip>"
  valid_ipv4 "$3" || die "redis-private-ip must be an IPv4 address, got '$3'"
fi
REDIS_HOST=$1
APP_HOST=$2
REDIS_IP=${3:-}

# Remote side of the crontab edit, run with `bash -s -- <role> [ip]`.
# role: redis | app | remove
# shellcheck disable=SC2016  # runs on the host, so nothing may expand here
CRON_SCRIPT='
set -euo pipefail
role=$1; ip=${2:-}
d=$HOME/perf
ts=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$d"
crontab -l > "$d/crontab.bak.$ts" 2> /dev/null || : > "$d/crontab.bak.$ts"
echo "crontab saved to $d/crontab.bak.$ts"
grep -v "# blot-perf" "$d/crontab.bak.$ts" > "$d/crontab.new" || true
case "$role" in
  redis)
    echo "* * * * * $d/redis-sample.sh >> $d/cron.log 2>&1 # blot-perf" >> "$d/crontab.new"
    echo "* * * * * python3 $d/latency-probe.py --label redis-local --host 127.0.0.1 >> $d/cron.log 2>&1 # blot-perf" >> "$d/crontab.new" ;;
  app)
    echo "* * * * * python3 $d/latency-probe.py --label app-to-redis --host $ip >> $d/cron.log 2>&1 # blot-perf" >> "$d/crontab.new" ;;
esac
crontab "$d/crontab.new"
rm -f "$d/crontab.new"
echo "crontab now has $(crontab -l | grep -c "# blot-perf") blot-perf line(s)"
'

# check_prereqs <ssh-fn> <host> <commands...>: fail if a command is missing there.
check_prereqs() {
  local ssh=$1 host=$2 missing
  shift 2
  missing=$($ssh "$host" "for c in $*; do command -v \$c > /dev/null 2>&1 || printf '%s ' \$c; done") ||
    die "cannot ssh to $host"
  [ -z "$missing" ] || die "$host is missing: $missing(install them first; cron is cronie: dnf install cronie && systemctl enable --now crond)"
  $ssh "$host" "python3 -c 'import sys; sys.exit(sys.version_info < (3, 6))'" ||
    die "$host: python3 is older than 3.6"
}

# push <ssh-fn> <host> <files...>: copy files from this directory to ~/perf on the host.
push() {
  local ssh=$1 host=$2
  shift 2
  # COPYFILE_DISABLE stops macOS tar adding ._ files and extended attributes.
  COPYFILE_DISABLE=1 tar -C "$PERF_DIR_LOCAL" -cf - "$@" |
    $ssh "$host" "mkdir -p ~/perf && tar -xf - -C ~/perf && cd ~/perf && chmod +x $*"
}

if [ "$UNINSTALL" = 1 ]; then
  echo "== $REDIS_HOST: removing blot-perf crontab lines"
  ssh_run "$REDIS_HOST" "bash -s -- remove" <<< "$CRON_SCRIPT"
  echo "== $APP_HOST: removing blot-perf crontab lines"
  app_ssh "$APP_HOST" "bash -s -- remove" <<< "$CRON_SCRIPT"
  echo "Done. Logs and scripts are still in ~/perf on both hosts."
  exit 0
fi

echo "== Checking prerequisites"
check_prereqs ssh_run "$REDIS_HOST" python3 flock timeout crontab redis6-cli
check_prereqs app_ssh "$APP_HOST" python3 timeout crontab
echo "ok"

echo "== Redis host ($REDIS_HOST)"
push ssh_run "$REDIS_HOST" redis-sample.sh latency-probe.py
ssh_run "$REDIS_HOST" "bash -s -- redis" <<< "$CRON_SCRIPT"
echo "-- redis-sample.sh (run twice, 2s apart, so the deltas show; the first run is not logged):"
# shellcheck disable=SC2088  # ~ is meant to expand on the host
ssh_run "$REDIS_HOST" '~/perf/redis-sample.sh --stdout > /dev/null; sleep 2; ~/perf/redis-sample.sh --stdout'
echo "-- latency-probe.py against 127.0.0.1 (5s, not logged):"
ssh_run "$REDIS_HOST" 'python3 ~/perf/latency-probe.py --label redis-local --host 127.0.0.1 --duration 5 --log -'

echo "== App host ($APP_HOST)"
push app_ssh "$APP_HOST" latency-probe.py
app_ssh "$APP_HOST" "bash -s -- app $REDIS_IP" <<< "$CRON_SCRIPT"
echo "-- latency-probe.py against $REDIS_IP (5s, not logged):"
app_ssh "$APP_HOST" "python3 ~/perf/latency-probe.py --label app-to-redis --host $REDIS_IP --duration 5 --log -"

echo
echo "Installed. Cron starts logging at the next minute: ~/perf/redis-sample.log and ~/perf/latency-*.log."
echo "Errors, if any, go to ~/perf/cron.log. Check back in a few minutes with:"
echo "  ssh <host> 'tail -n 2 ~/perf/*.log'"
