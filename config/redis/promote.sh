#!/bin/bash
# Usage: promote.sh [options] <old-ssh-host> <new-ssh-host>
# Promotes the replica on <new> to master with Redis's FAILOVER command, which
# also turns the master on <old> into a replica of <new>, then marks <new> as
# the host that uploads backups (bin/backup.sh only runs on the host with
# /etc/blot-redis/active). Rollback is this script with the hosts swapped; it
# prints the exact command at the end. Both hosts must have been set up by
# bootstrap.sh. See README.md ("Promotion").
#
# Why FAILOVER and not readonly.sh + REPLICAOF NO ONE: FAILOVER blocks every
# write on <old> (scripts and PUBLISH included), waits for <new> to catch up
# and promotes it. Blocked writes either run on <old> once it gives up
# (TIMEOUT) or get READONLY once it has switched, so no acknowledged write is
# lost and the two hosts never both take writes. It also leaves <old>
# replicating from <new>, which is what rollback needs.
#
# Options:
#   --timeout-ms MS      how long FAILOVER may wait for <new> to catch up before
#                        giving up, writes then resume on <old> (default 2000)
#   --lock-wait SECONDS  how long to wait for held folder locks (default 120)
#   --yes                do not ask for confirmation
#   --dry-run            run the checks and print every step; change nothing
set -euo pipefail
. "$(dirname "$0")/lib.sh"

TIMEOUT_MS=2000; LOCK_WAIT=120; DRY_RUN=""; YES=""
MAX_LAG_BYTES=16777216 # how far behind <new> may be when we start
MAX_LAG_SECONDS=3 # how long since <new>'s last ack may be when we start

while [ $# -gt 0 ]; do
  case "$1" in
    --timeout-ms | --lock-wait) [ $# -ge 2 ] || die "$1 needs a value" ;;
  esac
  case "$1" in
    --timeout-ms) TIMEOUT_MS=$2; shift 2 ;;
    --lock-wait) LOCK_WAIT=$2; shift 2 ;;
    --yes) YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -*) die "unknown option $1" ;;
    *) break ;;
  esac
done
[ $# -eq 2 ] || die "usage: promote.sh [options] <old-ssh-host> <new-ssh-host>"
OLD=$1; NEW=$2
[ "$OLD" != "$NEW" ] || die "the old and new host are the same"
case "$TIMEOUT_MS$LOCK_WAIT" in *[!0-9]*) die "--timeout-ms and --lock-wait take a number" ;; esac

is_ip() { echo "$1" | grep -qE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; }
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }
say() { printf '\n==> %s\n' "$*"; }
# problem <text>: something went wrong after the promotion. The run carries on
# (the later steps still matter), then reports them all and exits 1.
PROBLEMS=""
problem() { echo "WARNING: $*"; PROBLEMS="$PROBLEMS$*
"; }

# One ssh connection per host for the whole run: writes are blocked while
# FAILOVER runs and each new ssh handshake costs hundreds of milliseconds.
CTL=/tmp/blot-promote.$$
mkdir -m 700 "$CTL"
SSH_OPTS="${SSH_OPTS:-} -o ControlMaster=auto -o ControlPath=$CTL/%C -o ControlPersist=120"
STAGE=checks
cleanup() {
  local status=$?
  for h in $OLD $NEW; do ssh -o ControlPath="$CTL/%C" -O exit "$h" > /dev/null 2>&1 || true; done
  rm -rf "$CTL"
  if [ "$status" != 0 ] && [ "$STAGE" != checks ] && [ "$STAGE" != done ]; then
    echo "error: stopped while: $STAGE" >&2
    echo "Check 'redis6-cli INFO replication' on both hosts before anything else." >&2
  fi
}
trap cleanup EXIT

# on <host> [VAR=value...] < script: run a bash script on <host> with those
# variables set. The values are IPs, names and numbers checked above.
on() {
  local host=$1
  shift
  { for v in "$@"; do echo "$v"; done; cat; } | ssh_run "$host" "bash -s"
}
# field <text> <key>: the value from a "key=value" line.
field() { echo "$1" | awk -v k="$2" '{i = index($0, "=")} i && substr($0, 1, i - 1) == k {print substr($0, i + 1); exit}'; }

# Everything the checks need from a host, as key=value lines, in one round
# trip. The primary IP is the source address the host uses to go out.
gather() {
  on "$1" << 'EOF'
r() { redis6-cli "$@" | tr -d '\r'; }
info=$(r INFO replication && r INFO server && r INFO memory && r INFO persistence) && [ -n "$info" ] || { echo redis=down; exit 0; }
echo redis=up
echo "$info" | grep -E '^(redis_version|role|master_host|master_port|master_link_status|master_repl_offset|master_failover_state|used_memory|rdb_last_bgsave_status|slave[0-9]+):' | sed 's/:/=/'
echo "min_replicas=$(r CONFIG GET min-replicas-to-write | tail -n 1)"
echo "maxmemory=$(r CONFIG GET maxmemory | tail -n 1)"
echo "stop_writes_on_bgsave_error=$(r CONFIG GET stop-writes-on-bgsave-error | tail -n 1)"
# The proxy's certificates (lua-resty-auto-ssl keys ssl:<domain>:latest) and
# its issuance locks (ssl:<domain>:issue_cert_lock), with SCAN, never KEYS.
r --scan --pattern 'ssl:*' | awk '/:latest$/ {c++} /:issue_cert_lock$/ {l++} END {print "ssl_latest=" c + 0; print "ssl_locks=" l + 0}'
echo "primary_ip=$(ip -4 -o route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
[ -e /etc/blot-redis/active ] && echo active=yes
[ -e /etc/blot-redis/drill ] && echo drill=yes
if [ -f /etc/cron.d/blot-redis ] && [ -x /usr/local/bin/backup.sh ] && [ -d /etc/blot-redis ]; then
  echo bootstrapped=yes
else
  echo bootstrapped=no
fi
echo "sudo=$(sudo -n true 2> /dev/null && echo yes || echo no)"
EOF
}

# failover <ssh-host> <target-ip> <lock-wait>: on <ssh-host>, wait until no
# folder lock is held (a sync holding one could lose it in the switch), then
# FAILOVER to <target-ip> and wait until the host is a replica (done) or a
# master again (aborted). FAILOVER's TIMEOUT only covers the catch-up: if the
# target stops answering after that, the host stays a replica that refuses
# writes indefinitely, so we abort it ourselves 1s later (stuck). Prints
# result=, and t0= and t1= in ms on that host's clock.
failover() {
  on "$1" "TARGET=$2" "LOCK_WAIT=$3" "TIMEOUT_MS=$TIMEOUT_MS" << 'EOF'
ms() { date +%s%3N; }
state() { redis6-cli INFO replication | tr -d '\r' | awk -F: '$1 == "role" || $1 == "master_failover_state" {printf "%s ", $2}'; }
# The number of held locks; a failed scan counts as held.
locks() { out=$(redis6-cli --scan --pattern 'blog:*:folder-lock') || { echo 1; return; }; echo "$out" | grep -c . || true; }
if [ "$LOCK_WAIT" -gt 0 ]; then
  end=$(($(date +%s) + LOCK_WAIT))
  until [ "$(locks)" -eq 0 ]; do
    [ "$(date +%s)" -lt "$end" ] || { echo "result=locked"; echo "t0=0"; echo "t1=0"; exit 0; }
    sleep 1
  done
fi
t0=$(ms)
reply=$(redis6-cli FAILOVER TO "$TARGET" 6379 TIMEOUT "$TIMEOUT_MS" | tr -d '\r')
[ "$reply" = OK ] || { echo "result=refused: $reply"; echo "t0=$t0"; echo "t1=$(ms)"; exit 0; }
deadline=$((t0 + TIMEOUT_MS + 1000))
while :; do
  now=$(ms)
  case "$(state)" in
    "slave no-failover ") result=done; break ;;
    "master no-failover ") result=aborted; break ;;
  esac
  if [ "$now" -gt "$deadline" ]; then redis6-cli FAILOVER ABORT > /dev/null; result=stuck; break; fi
  sleep 0.02
done
echo "result=$result"; echo "t0=$t0"; echo "t1=$now"
EOF
}

say "Checking $OLD and $NEW"
OLD_INFO=$(gather "$OLD") || die "cannot run commands on $OLD"
NEW_INFO=$(gather "$NEW") || die "cannot run commands on $NEW"
for h in OLD NEW; do
  eval "info=\$${h}_INFO; host=\$$h"
  [ "$(field "$info" redis)" = up ] || die "Redis is not answering on $host"
  case "$(field "$info" redis_version)" in 6.2.*) ;; *) die "$host runs Redis '$(field "$info" redis_version)', not 6.2.x" ;; esac
  is_ip "$(field "$info" primary_ip)" || die "cannot find the primary IP of $host"
  [ "$(field "$info" sudo)" = yes ] || die "passwordless sudo does not work on $host"
  [ "$(field "$info" master_failover_state)" = no-failover ] || die "a FAILOVER is already in progress on $host"
done
OLD_IP=$(field "$OLD_INFO" primary_ip); NEW_IP=$(field "$NEW_INFO" primary_ip)
echo "$OLD: Redis $(field "$OLD_INFO" redis_version), $(field "$OLD_INFO" role), primary IP $OLD_IP"
echo "$NEW: Redis $(field "$NEW_INFO" redis_version), $(field "$NEW_INFO" role), primary IP $NEW_IP"

[ "$(field "$OLD_INFO" role)" = master ] || die "$OLD is not a master"
[ "$(field "$OLD_INFO" min_replicas)" = 0 ] ||
  echo "WARNING: min-replicas-to-write is $(field "$OLD_INFO" min_replicas) on $OLD (readonly.sh on?): it refuses writes already"
# The replica must follow the old host's own address: it is the one FAILOVER
# and the rollback use.
[ "$(field "$NEW_INFO" role)" = slave ] || die "$NEW is not a replica (on it: redis6-cli REPLICAOF $OLD_IP 6379)"
[ "$(field "$NEW_INFO" master_host):$(field "$NEW_INFO" master_port)" = "$OLD_IP:6379" ] ||
  die "$NEW replicates from $(field "$NEW_INFO" master_host):$(field "$NEW_INFO" master_port), not from $OLD's primary IP $OLD_IP:6379"
[ "$(field "$NEW_INFO" master_link_status)" = up ] || die "$NEW's replication link is down"
# From one INFO snapshot on <old>: slaveN=ip=...,port=...,state=...,offset=...,lag=...
replica=$(echo "$OLD_INFO" | grep -E '^slave[0-9]+=' | grep "=ip=$NEW_IP,port=6379," | head -n 1 | cut -d= -f2-)
[ -n "$replica" ] || die "$OLD does not list $NEW_IP:6379 as a replica (FAILOVER needs that address)"
r() { echo "$replica" | tr ',' '\n' | awk -F= -v k="$1" '$1 == k {print $2}'; }
behind=$(($(field "$OLD_INFO" master_repl_offset) - $(r offset)))
[ "$(r state)" = online ] || die "$NEW is '$(r state)' on $OLD, not online"
# Replicas ack once a second, so one late ack reads as 2s on a healthy replica.
[ "$(r lag)" -le "$MAX_LAG_SECONDS" ] && [ "$behind" -le "$MAX_LAG_BYTES" ] || die "$NEW is too far behind ($behind bytes, last ack $(r lag)s ago)"
echo "Replication: $NEW is $behind bytes behind, last ack $(r lag)s ago"
# Once promoted, min-replicas-to-write, more data than maxmemory allows
# (noeviction: OOM on every write) or a failed background save (MISCONF on
# every write) would refuse writes straight away.
[ "$(field "$NEW_INFO" min_replicas)" = 0 ] || die "min-replicas-to-write is $(field "$NEW_INFO" min_replicas) on $NEW; it would refuse writes once promoted"
maxmem=$(field "$NEW_INFO" maxmemory); used=$(field "$NEW_INFO" used_memory)
[ "$maxmem" = 0 ] || [ "$used" -lt $((maxmem / 10 * 8)) ] || die "$NEW uses $used bytes, over 80% of its maxmemory $maxmem"
[ "$(field "$NEW_INFO" rdb_last_bgsave_status)" = ok ] || [ "$(field "$NEW_INFO" stop_writes_on_bgsave_error)" != yes ] ||
  die "the last background save on $NEW failed and stop-writes-on-bgsave-error is yes; it would refuse every write once promoted (MISCONF)"
# The proxy trusts Redis over its own stale copy of a certificate, so one
# missing on <new> would be re-issued about an hour later.
[ "$(field "$NEW_INFO" ssl_latest)" = "$(field "$OLD_INFO" ssl_latest)" ] ||
  die "$NEW has $(field "$NEW_INFO" ssl_latest) ssl:*:latest certificate keys, $OLD has $(field "$OLD_INFO" ssl_latest); wait for replication and retry"
echo "Certificates: $(field "$OLD_INFO" ssl_latest) ssl:*:latest keys on both hosts"
[ "$(field "$OLD_INFO" ssl_locks)" = 0 ] ||
  echo "WARNING: the proxy is issuing a certificate right now ($(field "$OLD_INFO" ssl_locks) ssl:*:issue_cert_lock keys); better to wait a minute"
[ "$(field "$NEW_INFO" bootstrapped)" = yes ] ||
  die "$NEW was not set up by bootstrap.sh (no /etc/cron.d/blot-redis, backup.sh or /etc/blot-redis): nothing would back it up"
[ "$(field "$NEW_INFO" drill)" != yes ] ||
  echo "WARNING: $NEW is a drill host (/etc/blot-redis/drill): it will never upload backups"
[ "$(field "$OLD_INFO" active)" = yes ] || echo "WARNING: $OLD is not marked active (/etc/blot-redis/active): its backups were not running"
[ "$(field "$NEW_INFO" active)" != yes ] || echo "WARNING: $NEW is already marked active (/etc/blot-redis/active)"

# The command that undoes all of this, with the options it will need.
ROLLBACK="$0"
[ "$TIMEOUT_MS" = 2000 ] || ROLLBACK="$ROLLBACK --timeout-ms $TIMEOUT_MS"
[ "$LOCK_WAIT" = 120 ] || ROLLBACK="$ROLLBACK --lock-wait $LOCK_WAIT"
ROLLBACK="$ROLLBACK $NEW $OLD"

say "Plan"
cat << EOF
 1. $OLD: wait until no blog:*:folder-lock is held (up to ${LOCK_WAIT}s), then
    FAILOVER TO $NEW_IP 6379 TIMEOUT $TIMEOUT_MS (FAILOVER ABORT if not done after $((TIMEOUT_MS + 1000))ms)
 2. sudo touch /etc/blot-redis/active on $NEW, sudo rm -f it on $OLD
 3. check $NEW is the master and takes a write, and $OLD replicates from it
Rollback afterwards: $ROLLBACK
EOF
if [ -n "$DRY_RUN" ]; then echo; echo "Dry run: nothing changed."; exit 0; fi

if [ -z "$YES" ]; then
  read -r -p "Promote $NEW and demote $OLD? Type yes: " reply || die "no answer (use --yes when not running interactively)"
  [ "$reply" = yes ] || die "aborted"
fi

# old_state: "<role> <master_failover_state> <master_host>" as <old> reports
# it now, nothing if it cannot be asked.
old_state() {
  local info
  info=$(ssh_run "$OLD" "redis6-cli INFO replication" 2> /dev/null | tr -d '\r' | sed 's/:/=/') || return 0
  echo "$(field "$info" role) $(field "$info" master_failover_state) $(field "$info" master_host)"
}
# settle_old: ask <old> how the FAILOVER ended and set settled=done (a replica
# of <new>) or settled=aborted (the master). One still in progress gets a few
# seconds past TIMEOUT, then our own FAILOVER ABORT. Anything else dies, with
# <new> untouched: REPLICAOF there while <old> is a replica would leave no master.
settle_old() {
  local st role fstate mhost deadline abort_sent=""
  deadline=$(($(now_ms) + TIMEOUT_MS + 3000))
  while :; do
    st=$(old_state)
    read -r role fstate mhost <<< "$st"
    case "$fstate" in
      no-failover)
        [ "$role" != master ] || { settled=aborted; return 0; }
        [ "$role$mhost" != "slave$NEW_IP" ] || { settled=done; return 0; }
        break ;;
      failover-in-progress | waiting-for-sync)
        if [ "$(now_ms)" -gt "$deadline" ]; then
          [ -z "$abort_sent" ] || break
          ssh_run "$OLD" "redis6-cli FAILOVER ABORT" > /dev/null 2>&1 || true
          abort_sent=1; deadline=$(($(now_ms) + 2000))
        fi
        sleep 0.1 ;;
      *) break ;;
    esac
  done
  die "cannot tell how the FAILOVER ended ($OLD says: ${st:-nothing}); $NEW was not touched. Check 'redis6-cli INFO replication' on both hosts before anything else."
}

STAGE="FAILOVER (if unsure how it ended, run FAILOVER ABORT on $OLD)"
say "1. FAILOVER $OLD -> $NEW"
out=$(failover "$OLD" "$NEW_IP" "$LOCK_WAIT") || out="result=unknown"
result=$(field "$out" result); T0=$(field "$out" t0); T1=$(field "$out" t1)
echo "$result${T0:+ after $((T1 - T0))ms}"
if [ "$result" != done ]; then
  # FAILOVER keeps going inside Redis when our session dies, and "stuck" is
  # our abort racing it, so <old> may be a replica of <new> already.
  settle_old
  if [ "$settled" = done ]; then
    echo "$OLD is a replica of $NEW: the FAILOVER did complete; carrying on"
    result=done; T0=$(now_ms); T1=$T0 # <old>'s clock cannot time it now
  fi
fi
if [ "$result" != done ]; then
  # <old> is the master again (settle_old checked) and takes writes. If <new>
  # got as far as promoting itself it is a second master: re-attach it.
  if ssh_run "$NEW" "redis6-cli INFO replication" | tr -d '\r' | grep -qx role:master; then
    echo "$NEW had promoted itself; making it a replica of $OLD again"
    ssh_run "$NEW" "redis6-cli REPLICAOF $OLD_IP 6379"
  fi
  STAGE=done
  die "FAILOVER did not complete ($result): $OLD is still the master and takes writes. Nothing else changed."
fi

STAGE="after the FAILOVER ($NEW is the master; the active marker may not have moved)"
say "2. Marking $NEW as the active host"
ssh_run "$NEW" "sudo -n touch /etc/blot-redis/active" ||
  problem "could not write /etc/blot-redis/active on $NEW (its backups will not run): run there: sudo touch /etc/blot-redis/active"
ssh_run "$OLD" "sudo -n rm -f /etc/blot-redis/active" ||
  problem "could not remove /etc/blot-redis/active on $OLD: run there: sudo rm -f /etc/blot-redis/active"

say "3. Checking"
[ "$(ssh_run "$NEW" "redis6-cli INFO replication" | tr -d '\r' | grep '^role:')" = role:master ] || die "$NEW is not a master"
[ "$(ssh_run "$NEW" "redis6-cli SET blot:promote:check $T0 EX 60" | tr -d '\r')" = OK ] || die "$NEW refuses writes"
# Rollback needs <old> replicating from <new> with its link up (its own
# checks refuse otherwise); the link may still be finishing its sync.
link=""
for _ in $(seq 1 20); do
  link=$(ssh_run "$OLD" "redis6-cli INFO replication" | tr -d '\r' | grep -E '^(master_host|master_link_status):' | tr '\n' ' ' || true)
  [ "$link" != "master_host:$NEW_IP master_link_status:up " ] || break
  sleep 0.5
done
[ "$link" = "master_host:$NEW_IP master_link_status:up " ] ||
  problem "$OLD is not replicating from $NEW_IP with its link up (${link:-no answer}); rollback needs it to"
STAGE=done

if [ -n "$PROBLEMS" ]; then
  echo >&2
  echo "error: $NEW is the master, but:" >&2
  printf '%s' "$PROBLEMS" | sed 's/^/  - /' >&2
  echo "Rollback: $ROLLBACK" >&2
  exit 1
fi

say "Done: $NEW is the master (FAILOVER took $((T1 - T0))ms)"
echo "Rollback: $ROLLBACK"
