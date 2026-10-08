#!/bin/bash
# Usage: cutover.sh [options] <old-ssh-host> <new-ssh-host>
# Moves live traffic from the Redis master on <old> to its replica on <new>:
# promotes <new> with Redis's FAILOVER command (which also turns <old> into a
# replica of <new>), moves the floating IP to <new>, marks <new> as the host
# that uploads backups, and turns off the old hand-made backup cron jobs on
# <old>. Rollback is this script with the hosts swapped; it prints the exact
# command at the end. See README.md ("Cutover").
#
# Why FAILOVER and not readonly.sh + REPLICAOF NO ONE: FAILOVER blocks every
# write on <old> (scripts and PUBLISH included), waits for <new> to catch up
# and promotes it, typically in well under a second. Blocked writes either
# run on <old> once it gives up (TIMEOUT) or get READONLY once it has
# switched, so no acknowledged write is lost and the two hosts never both
# take writes. It also leaves <old> replicating from <new>, which is what
# rollback needs.
#
# Options:
#   --ip IP              the floating IP (default: /etc/blot-redis/floating-ip
#                        on <old>, else the only secondary IP on its interface)
#   --app-host HOST      ssh host whose neighbour (ARP) entry for the IP to flush
#                        right after the move; repeat for several hosts
#   --no-neigh-flush     flush nothing (to measure the difference in a rehearsal)
#   --timeout-ms MS      how long FAILOVER may wait for <new> to catch up before
#                        giving up, writes then resume on <old> (default 2000)
#   --lock-wait SECONDS  how long to wait for held folder locks (default 120)
#   --profile NAME       AWS CLI profile       --region NAME   (default us-west-2)
#   --allow-unbootstrapped  <new> was not set up by bootstrap.sh (rolling back
#                        to the hand-built host); nothing will back it up
#   --any-time           skip the refusal near :00, :30 and 01:00 (rehearsals)
#   --yes                do not ask for confirmation
#   --dry-run            run the checks and print every step; change nothing
# CUTOVER_CLIENT_WAIT (seconds, default 10): how long to watch clients
# arrive on <new> afterwards.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

FIP=""; APP_HOSTS=""; NO_NEIGH=""; TIMEOUT_MS=2000; LOCK_WAIT=120; DRY_RUN=""; YES=""
ANY_TIME=""; ALLOW_UNBOOTSTRAPPED=""; AWS_REGION=${AWS_REGION:-us-west-2}; AWS_PROFILE_ARGS=""
CLIENT_WAIT=${CUTOVER_CLIENT_WAIT:-10}
# Writes are unavailable from the FAILOVER until clients reach <new>. A
# folder lock (app/sync/lock.js) is lost once its key expires on the server,
# 10s after its last heartbeat (every 3s), so measured with the real client
# the window must stay under 6-9s depending on where it falls. Aim for ~3s.
BUDGET_MS=5000
MAX_LAG_BYTES=16777216 # how far behind <new> may be when we start
# Crontab entries on <old> to leave alone: the monitoring logs. Everything
# else on the hand-built host (backups, stats.sh) is turned off.
KEEP_CRON='tcpmem-log[.]sh|redis-mem-log[.]sh'

while [ $# -gt 0 ]; do
  case "$1" in
    --ip | --app-host | --timeout-ms | --lock-wait | --profile | --region) [ $# -ge 2 ] || die "$1 needs a value" ;;
  esac
  case "$1" in
    --ip) FIP=$2; shift 2 ;;
    --app-host) APP_HOSTS="$APP_HOSTS $2"; shift 2 ;;
    --no-neigh-flush) NO_NEIGH=1; shift ;;
    --timeout-ms) TIMEOUT_MS=$2; shift 2 ;;
    --lock-wait) LOCK_WAIT=$2; shift 2 ;;
    --profile) AWS_PROFILE_ARGS="--profile $2"; shift 2 ;;
    --region) AWS_REGION=$2; shift 2 ;;
    --allow-unbootstrapped) ALLOW_UNBOOTSTRAPPED=1; shift ;;
    --any-time) ANY_TIME=1; shift ;;
    --yes) YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -*) die "unknown option $1" ;;
    *) break ;;
  esac
done
[ $# -eq 2 ] || die "usage: cutover.sh [options] <old-ssh-host> <new-ssh-host>"
OLD=$1; NEW=$2
[ "$OLD" != "$NEW" ] || die "the old and new host are the same"
case "$TIMEOUT_MS$LOCK_WAIT" in *[!0-9]*) die "--timeout-ms and --lock-wait take a number" ;; esac
[ -n "$APP_HOSTS" ] || [ -n "$NO_NEIGH" ] ||
  die "pass --app-host <ssh-host> (to flush the app host's ARP entry for the IP) or --no-neigh-flush"
[ -z "$APP_HOSTS" ] || [ -z "$NO_NEIGH" ] || die "--app-host and --no-neigh-flush contradict each other"

is_ip() { echo "$1" | grep -qE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; }
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }
say() { printf '\n==> %s\n' "$*"; }
# shellcheck disable=SC2086
aws_cli() { aws $AWS_PROFILE_ARGS --region "$AWS_REGION" "$@"; }

# One ssh connection per host for the whole run: the switch is timed in
# milliseconds and each new ssh handshake costs hundreds.
CTL=/tmp/blot-cutover.$$
mkdir -m 700 "$CTL"
SSH_OPTS="${SSH_OPTS:-} -o ControlMaster=auto -o ControlPath=$CTL/%C -o ControlPersist=120"
STAGE=checks
cleanup() {
  local status=$?
  for h in $OLD $NEW $APP_HOSTS; do ssh -o ControlPath="$CTL/%C" -O exit "$h" > /dev/null 2>&1 || true; done
  rm -rf "$CTL"
  if [ "$status" != 0 ] && [ "$STAGE" != checks ] && [ "$STAGE" != done ]; then
    echo "error: stopped while: $STAGE" >&2
    echo "Check 'redis6-cli INFO replication' on both hosts and where $FIP is before anything else." >&2
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
# trip. The primary IP is the source address the host uses to go out; AWS
# confirms below that it is the interface's primary address.
gather() {
  on "$1" "KEEP_CRON='$KEEP_CRON'" << 'EOF'
r() { redis6-cli "$@" | tr -d '\r'; }
info=$(r INFO replication && r INFO server && r INFO memory) && [ -n "$info" ] || { echo redis=down; exit 0; }
echo redis=up
echo "$info" | grep -E '^(redis_version|role|master_host|master_port|master_link_status|master_repl_offset|master_failover_state|used_memory|slave[0-9]+):' | sed 's/:/=/'
echo "min_replicas=$(r CONFIG GET min-replicas-to-write | tail -n 1)"
echo "maxmemory=$(r CONFIG GET maxmemory | tail -n 1)"
# The proxy's certificates (lua-resty-auto-ssl keys ssl:<domain>:latest) and
# its issuance locks (ssl:<domain>:issue_cert_lock), with SCAN, never KEYS.
r --scan --pattern 'ssl:*' | awk '/:latest$/ {c++} /:issue_cert_lock$/ {l++} END {print "ssl_latest=" c + 0; print "ssl_locks=" l + 0}'
# Normal clients per local address: how many come in through the floating IP.
r CLIENT LIST TYPE normal | sed -n 's/.* laddr=\([0-9.]*\):6379 .*/\1/p' | sort | uniq -c | awk '{print "clients_" $2 "=" $1}'
route=$(ip -4 -o route get 1.1.1.1)
echo "primary_ip=$(echo "$route" | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
iface=$(echo "$route" | sed -n 's/.* dev \([^ ]*\).*/\1/p')
echo "iface=$iface"
echo "addrs=$(ip -4 -o addr show dev "$iface" | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ')"
echo "marker=$(cat /etc/blot-redis/floating-ip 2> /dev/null | tr -d '[:space:]')"
if [ -f /etc/cron.d/blot-redis ] && [ -x /usr/local/bin/backup.sh ] && [ -d /etc/blot-redis ]; then
  echo bootstrapped=yes
else
  echo bootstrapped=no
fi
if command -v systemctl > /dev/null && systemctl is-active --quiet "refresh-policy-routes@$iface.timer"; then
  echo timer=active
else
  echo timer=none
fi
echo "s3_running=$(pgrep -f 'aws s3 (cp|rm|sync)' | wc -l | tr -d ' ')"
echo "sudo=$(sudo -n true 2> /dev/null && echo yes || echo no)"
crontab -l 2> /dev/null | grep -vE '^[[:space:]]*(#|$)' | grep -vE '^[A-Za-z_]+=' | grep -vE "$KEEP_CRON" | sed 's/^/cron=/' || true
ls -t ~/crontab.before-cutover-* 2> /dev/null | head -n 1 | sed 's/^/cron_backup=/' || true
EOF
}

# eni <primary-ip>: "<eni> <instance> <subnet> <primary-ip> <secondary,ips>"
eni() {
  aws_cli ec2 describe-network-interfaces --filters "Name=addresses.private-ip-address,Values=$1" \
    --query 'NetworkInterfaces[0].[NetworkInterfaceId, Attachment.InstanceId, SubnetId, join(`,`, PrivateIpAddresses[?Primary].PrivateIpAddress), join(`,`, PrivateIpAddresses[?!Primary].PrivateIpAddress)]' \
    --output text | tr '\t' ' '
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
  [ "$(field "$info" s3_running)" = 0 ] || die "an 'aws s3' command is running on $host (a backup?); wait for it"
  [ "$(field "$info" master_failover_state)" = no-failover ] || die "a FAILOVER is already in progress on $host"
done
OLD_IP=$(field "$OLD_INFO" primary_ip); NEW_IP=$(field "$NEW_INFO" primary_ip)
OLD_IF=$(field "$OLD_INFO" iface); NEW_IF=$(field "$NEW_INFO" iface)
echo "$OLD: Redis $(field "$OLD_INFO" redis_version), $(field "$OLD_INFO" role), primary IP $OLD_IP ($OLD_IF)"
echo "$NEW: Redis $(field "$NEW_INFO" redis_version), $(field "$NEW_INFO" role), primary IP $NEW_IP ($NEW_IF)"

[ "$(field "$OLD_INFO" role)" = master ] || die "$OLD is not a master"
[ "$(field "$OLD_INFO" min_replicas)" = 0 ] ||
  echo "WARNING: min-replicas-to-write is $(field "$OLD_INFO" min_replicas) on $OLD (readonly.sh on?): it refuses writes already"
# The replica must follow the old host's own address: following the floating
# IP, it would replicate from itself once the IP moves.
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
[ "$(r lag)" -le 1 ] && [ "$behind" -le "$MAX_LAG_BYTES" ] || die "$NEW is too far behind ($behind bytes, last ack $(r lag)s ago)"
echo "Replication: $NEW is $behind bytes behind, last ack $(r lag)s ago"
# Once promoted, min-replicas-to-write, or more data than maxmemory allows
# (noeviction: OOM on every write), would refuse writes straight away.
[ "$(field "$NEW_INFO" min_replicas)" = 0 ] || die "min-replicas-to-write is $(field "$NEW_INFO" min_replicas) on $NEW; it would refuse writes once promoted"
maxmem=$(field "$NEW_INFO" maxmemory); used=$(field "$NEW_INFO" used_memory)
[ "$maxmem" = 0 ] || [ "$used" -lt $((maxmem / 10 * 8)) ] || die "$NEW uses $used bytes, over 80% of its maxmemory $maxmem"
# The proxy trusts Redis over its own stale copy of a certificate, so one
# missing on <new> would be re-issued about an hour later.
[ "$(field "$NEW_INFO" ssl_latest)" = "$(field "$OLD_INFO" ssl_latest)" ] ||
  die "$NEW has $(field "$NEW_INFO" ssl_latest) ssl:*:latest certificate keys, $OLD has $(field "$OLD_INFO" ssl_latest); wait for replication and retry"
echo "Certificates: $(field "$OLD_INFO" ssl_latest) ssl:*:latest keys on both hosts"
[ "$(field "$OLD_INFO" ssl_locks)" = 0 ] ||
  echo "WARNING: the proxy is issuing a certificate right now ($(field "$OLD_INFO" ssl_locks) ssl:*:issue_cert_lock keys); better to wait a minute"
if [ "$(field "$NEW_INFO" bootstrapped)" != yes ]; then
  [ -n "$ALLOW_UNBOOTSTRAPPED" ] || die "$NEW was not set up by bootstrap.sh (no /etc/cron.d/blot-redis); pass --allow-unbootstrapped if you mean it"
  echo "WARNING: $NEW was not set up by bootstrap.sh: nothing will back it up"
fi

say "Checking AWS"
# This also gets the credentials and the CLI warm before the timed part.
aws_cli sts get-caller-identity --query Arn --output text || die "the AWS CLI does not work (aws sso login?)"
read -r OLD_ENI OLD_INSTANCE OLD_SUBNET OLD_PRIMARY OLD_SECONDARY <<< "$(eni "$OLD_IP")"
read -r NEW_ENI NEW_INSTANCE NEW_SUBNET NEW_PRIMARY NEW_SECONDARY <<< "$(eni "$NEW_IP")"
case "$OLD_ENI $NEW_ENI" in eni-*" "eni-*) ;; *) die "cannot find the network interfaces with $OLD_IP and $NEW_IP" ;; esac
[ "$OLD_PRIMARY" = "$OLD_IP" ] || die "$OLD_IP is not the primary IP of $OLD_ENI ($OLD_PRIMARY is)"
[ "$NEW_PRIMARY" = "$NEW_IP" ] || die "$NEW_IP is not the primary IP of $NEW_ENI ($NEW_PRIMARY is)"
[ "$OLD_SUBNET" = "$NEW_SUBNET" ] || die "the hosts are in different subnets ($OLD_SUBNET, $NEW_SUBNET); the IP cannot move"
[ "$OLD_SECONDARY" != None ] || OLD_SECONDARY=""
echo "$OLD: $OLD_INSTANCE $OLD_ENI, secondary IPs: ${OLD_SECONDARY:-none}"
echo "$NEW: $NEW_INSTANCE $NEW_ENI"
if [ -z "$FIP" ]; then
  FIP=$(field "$OLD_INFO" marker)
  if [ -z "$FIP" ]; then
    case "$OLD_SECONDARY" in *,* | "") die "cannot tell which IP is the floating IP ($OLD_ENI has: ${OLD_SECONDARY:-none}); pass --ip" ;; esac
    FIP=$OLD_SECONDARY
  fi
fi
is_ip "$FIP" || die "not an IP: $FIP"
case ",$OLD_SECONDARY," in *",$FIP,"*) ;; *) die "the floating IP $FIP is not on $OLD's interface $OLD_ENI" ;; esac
case " $(field "$OLD_INFO" addrs) " in *" $FIP "*) ;; *) die "$FIP is assigned to $OLD_ENI but not configured on $OLD ($OLD_IF)" ;; esac
CLIENTS=$(field "$OLD_INFO" "clients_$FIP"); CLIENTS=${CLIENTS:-0}
echo "Floating IP: $FIP, $CLIENTS clients connected through it"
[ "$CLIENTS" -gt 0 ] || echo "WARNING: no client is connected to $OLD through $FIP"

APP_IFS=""
for app in $APP_HOSTS; do
  dev=$(echo "sudo -n true || exit 1; ip -4 -o route get $FIP | sed -n 's/.* dev \([^ ]*\).*/\1/p'" | ssh_run "$app" "bash -s") ||
    die "cannot run sudo on the app host $app"
  [ -n "$dev" ] || die "no route from $app to $FIP"
  APP_IFS="$APP_IFS $app:$dev"
done

OLD_CRON=$(echo "$OLD_INFO" | sed -n 's/^cron=//p')
OLD_TIMER=$(field "$OLD_INFO" timer); NEW_TIMER=$(field "$NEW_INFO" timer)
NEW_HAS_FIP=""; case " $(field "$NEW_INFO" addrs) " in *" $FIP "*) NEW_HAS_FIP=1 ;; esac

# The command that undoes all of this, with the options it will need.
ROLLBACK="$0 --ip $FIP"
if [ -n "$NO_NEIGH" ]; then ROLLBACK="$ROLLBACK --no-neigh-flush"; else for app in $APP_HOSTS; do ROLLBACK="$ROLLBACK --app-host $app"; done; fi
[ "$(field "$OLD_INFO" bootstrapped)" = yes ] || ROLLBACK="$ROLLBACK --allow-unbootstrapped"
[ -z "$AWS_PROFILE_ARGS" ] || ROLLBACK="$ROLLBACK $AWS_PROFILE_ARGS"
ROLLBACK="$ROLLBACK --region $AWS_REGION $NEW $OLD"

say "Plan"
cat << EOF
 1. stop refresh-policy-routes@<if>.timer on $NEW ($NEW_TIMER) and $OLD ($OLD_TIMER)
    $NEW: ip addr add $FIP/32 dev $NEW_IF noprefixroute${NEW_HAS_FIP:+ (already there)}
 2. $OLD: wait until no blog:*:folder-lock is held (up to ${LOCK_WAIT}s), then
    FAILOVER TO $NEW_IP 6379 TIMEOUT $TIMEOUT_MS (FAILOVER ABORT if not done after $((TIMEOUT_MS + 1000))ms)
 3. aws ec2 assign-private-ip-addresses --network-interface-id $NEW_ENI --private-ip-addresses $FIP --allow-reassignment
 4. ${APP_IFS:+ip neigh del $FIP on:$APP_IFS; }wait for $NEW's metadata to list $FIP, then
    $OLD: ip addr del $FIP/32 dev $OLD_IF${APP_IFS:+; ip neigh del again}
 5. write $FIP to /etc/blot-redis/floating-ip on $NEW, remove it on $OLD
 6. $OLD: back up ec2-user's crontab, then comment out:
$(if [ -n "$OLD_CRON" ]; then echo "$OLD_CRON" | sed 's/^/      /'; else echo "      (nothing)"; fi)
 7. restart the refresh timers, watch clients arrive on $NEW for ${CLIENT_WAIT}s, check both hosts
Rollback afterwards: $ROLLBACK
EOF
if [ -n "$DRY_RUN" ]; then echo; echo "Dry run: nothing changed."; exit 0; fi

if [ -z "$YES" ]; then
  read -r -p "Cut over from $OLD to $NEW? Type yes: " reply || die "no answer (use --yes when not running interactively)"
  [ "$reply" = yes ] || die "aborted"
fi
# Hourly backups and sync validation run at :00 and :30, and the proxy's
# wildcard certificate renewal writes to Redis at 01:00.
hour=$((10#$(date -u +%H))); minute=$((10#$(date -u +%M)))
if [ -z "$ANY_TIME" ]; then
  [ $((minute % 30)) -ge 8 ] && [ $((minute % 30)) -le 25 ] ||
    die "too close to :00 or :30 (allowed :08-:25 and :38-:55)"
  [ "$hour" != 1 ] || [ "$minute" -ge 30 ] || die "too close to the 01:00 UTC certificate renewal"
fi

STAGE="preparing (nothing has switched)"
say "1. Preparing"
# The refresh timer rebuilds the interface's addresses from instance
# metadata, which would drop an address added by hand before the metadata
# lists it (and briefly renews the DHCP lease).
timer() { [ "$2" != active ] || ssh_run "$1" "sudo -n systemctl $3 refresh-policy-routes@$4.timer"; }
undo_prepare() {
  [ -n "$NEW_HAS_FIP" ] || ssh_run "$NEW" "sudo -n ip addr del $FIP/32 dev $NEW_IF" || true
  timer "$NEW" "$NEW_TIMER" start "$NEW_IF" || true
  timer "$OLD" "$OLD_TIMER" start "$OLD_IF" || true
}
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
# Configured before the move, so the moment the IP moves <new> answers the
# clients' old connections with a reset and they reconnect at once. An
# unserved IP is a black hole: a busy client keeps resetting its idle timer
# and its commands hang until something answers.
# In an if condition set -e is off for the whole && list, so a failure of any
# step lands in the then branch instead of exiting with the steps half done.
if ! { timer "$NEW" "$NEW_TIMER" stop "$NEW_IF" &&
  timer "$OLD" "$OLD_TIMER" stop "$OLD_IF" &&
  { [ -n "$NEW_HAS_FIP" ] || ssh_run "$NEW" "sudo -n ip addr add $FIP/32 dev $NEW_IF noprefixroute"; }; }; then
  undo_prepare
  STAGE=done
  die "preparation failed and was undone; nothing has switched"
fi

STAGE="FAILOVER (if unsure how it ended, run FAILOVER ABORT on $OLD)"
say "2. FAILOVER $OLD -> $NEW"
out=$(failover "$OLD" "$NEW_IP" "$LOCK_WAIT") || out="result=unknown"
result=$(field "$out" result); T0=$(field "$out" t0); T1=$(field "$out" t1)
echo "$result${T0:+ after $((T1 - T0))ms}"
if [ "$result" != done ]; then
  # FAILOVER keeps going inside Redis when our session dies, and "stuck" is
  # our abort racing it, so <old> may be a replica of <new> already.
  settle_old
  if [ "$settled" = done ]; then
    echo "$OLD is a replica of $NEW: the FAILOVER did complete; carrying on"
    result=done; T0=$(now_ms); T1=$T0 # timings below count from here, not from the FAILOVER
  fi
fi
if [ "$result" != done ]; then
  # <old> is the master again (settle_old checked), writes are back on it. If
  # <new> got as far as promoting itself it is a master no client can reach
  # yet (the IP has not moved): re-attach it.
  if ssh_run "$NEW" "redis6-cli INFO replication" | tr -d '\r' | grep -qx role:master; then
    echo "$NEW had promoted itself; making it a replica of $OLD again"
    ssh_run "$NEW" "redis6-cli REPLICAOF $OLD_IP 6379"
  fi
  undo_prepare
  STAGE=done
  die "FAILOVER did not complete ($result): $OLD is still the master and takes writes. Nothing else changed."
fi

STAGE="moving the IP ($NEW is the master; clients still reach $OLD and get READONLY)"
say "3. Moving $FIP to $NEW"
# Watch clients arrive on <new> from now on, in the background.
on "$NEW" "FIP=$FIP" "WANT=$CLIENTS" "WAIT=$CLIENT_WAIT" > "$CTL/clients" 2>&1 << 'EOF' &
ms() { date +%s%3N; }
end=$(($(ms) + WAIT * 1000)); first=""; n=0
while [ "$(ms)" -lt "$end" ]; do
  n=$(redis6-cli CLIENT LIST TYPE normal | grep -c "laddr=$FIP:6379" || true)
  [ "$n" -eq 0 ] || [ -n "$first" ] || first=$(ms)
  if [ "$WANT" -gt 0 ] && [ "$n" -ge "$WANT" ]; then echo "all=$(ms)"; break; fi
  sleep 0.05
done
echo "first=$first"; echo "count=$n"
EOF
WATCHER=$!
m0=$(now_ms)
if ! aws_cli --cli-connect-timeout 3 --cli-read-timeout 10 ec2 assign-private-ip-addresses \
  --network-interface-id "$NEW_ENI" --private-ip-addresses "$FIP" --allow-reassignment; then
  case ",$(eni "$NEW_IP" | awk '{print $5}')," in
    *",$FIP,"*) echo "The call failed, but $FIP is on $NEW_ENI: carrying on" ;;
    *)
      # Clients still reach <old>, now a replica: switch Redis straight back.
      echo "The IP did not move: switching Redis back to $OLD"
      out=$(failover "$NEW" "$OLD_IP" 0) || out="result=unknown"
      echo "FAILOVER back: $(field "$out" result)"
      [ "$(field "$out" result)" != done ] || undo_prepare
      die "the IP did not move; check that $OLD is the master again (redis6-cli INFO replication)" ;;
  esac
fi
m1=$(now_ms)
echo "assign-private-ip-addresses returned after $((m1 - m0))ms"

STAGE="after the IP move ($NEW is the master and owns $FIP)"
say "4. Data plane"
# A host that still has <old>'s MAC address for the IP keeps sending frames
# there, which the VPC drops, until the neighbour entry goes stale (20-50s).
# Docker containers on the app host share its neighbour table.
flush() {
  local pair pids=""
  for pair in $APP_IFS; do
    ssh_run "${pair%:*}" "sudo -n ip neigh del $FIP dev ${pair##*:} 2> /dev/null || true" &
    pids="$pids $!"
  done
  # Only these: a bare wait would also wait for the client watcher.
  for pid in $pids; do wait "$pid" || true; done
}
flush
# The move is asynchronous: the instance metadata lists the IP once it is done.
# <old> keeps the address until then, as a replica it answers whatever the VPC
# still delivers to it (reads work, writes get READONLY at once); without it
# those packets would be black-holed.
imds_wait='
t=$(curl -sf -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token)
mac=$(cat /sys/class/net/$IF/address)
for i in $(seq 1 $TRIES); do
  ips=" $(curl -sf -H "X-aws-ec2-metadata-token: $t" http://169.254.169.254/latest/meta-data/network/interfaces/macs/$mac/local-ipv4s | tr "\n" " ") "
  case "$ips" in *" $FIP "*) [ "$WANT" = yes ] && exit 0 ;; *) [ "$WANT" = no ] && exit 0 ;; esac
  sleep 0.2
done
exit 1'
if echo "$imds_wait" | on "$NEW" "FIP=$FIP" "IF=$NEW_IF" "WANT=yes" "TRIES=100"; then
  echo "$NEW's metadata lists $FIP $(($(now_ms) - m1))ms after the call"
else
  echo "WARNING: $NEW's metadata does not list $FIP after 20s"
fi
ssh_run "$OLD" "sudo -n ip addr del $FIP/32 dev $OLD_IF"
# Again, in case an entry was re-learned before the VPC switched (on a Docker
# bridge both containers answer ARP while both have the address).
flush

say "5. Marking $NEW as the active host"
ssh_run "$NEW" "sudo -n mkdir -p /etc/blot-redis && echo $FIP | sudo -n tee /etc/blot-redis/floating-ip > /dev/null"
ssh_run "$OLD" "sudo -n rm -f /etc/blot-redis/floating-ip"

say "6. Turning off the old backup jobs on $OLD"
# They have none of backup.sh's checks and upload to the same S3 names, so
# they would overwrite and prune the new host's backups.
on "$OLD" "KEEP_CRON='$KEEP_CRON'" << 'EOF'
current=$(crontab -l 2> /dev/null) || { echo "    no crontab"; exit 0; }
jobs=$(echo "$current" | grep -vE '^[[:space:]]*(#|$)' | grep -vE '^[A-Za-z_]+=' | grep -vE "$KEEP_CRON" || true)
[ -n "$jobs" ] || { echo "    nothing to turn off"; exit 0; }
backup=~/crontab.before-cutover-$(date -u +%Y%m%dT%H%M%SZ)
echo "$current" > "$backup"
echo "$current" | awk -v keep="$KEEP_CRON" '/^[[:space:]]*(#|$)/ || /^[A-Za-z_]+=/ || $0 ~ keep {print; next} {print "#cutover# " $0}' |
  crontab -
echo "$jobs" | sed 's/^/    turned off: /'
echo "    previous crontab: $backup"
EOF

say "7. Checking"
timer "$NEW" "$NEW_TIMER" start "$NEW_IF"
# Restart <old>'s timer only once its metadata has dropped the IP, or the
# timer would put the address straight back.
if [ "$OLD_TIMER" = active ]; then
  if echo "$imds_wait" | on "$OLD" "FIP=$FIP" "IF=$OLD_IF" "WANT=no" "TRIES=150"; then
    timer "$OLD" active start "$OLD_IF"
  else
    echo "WARNING: $OLD's metadata still lists $FIP; refresh-policy-routes@$OLD_IF.timer left stopped"
  fi
fi
wait "$WATCHER" || true
WATCH=$(cat "$CTL/clients")
first=$(field "$WATCH" first); all=$(field "$WATCH" all)
echo "Clients through $FIP on $NEW: $(field "$WATCH" count) (there were $CLIENTS on $OLD)"
[ "$(ssh_run "$NEW" "redis6-cli INFO replication" | tr -d '\r' | grep '^role:')" = role:master ] || die "$NEW is not a master"
[ "$(ssh_run "$NEW" "redis6-cli SET blot:cutover:check $T0 EX 60" | tr -d '\r')" = OK ] || die "$NEW refuses writes"
ssh_run "$OLD" "redis6-cli INFO replication" | tr -d '\r' | grep -qx "master_host:$NEW_IP" ||
  echo "WARNING: $OLD is not replicating from $NEW_IP; rollback needs it to"
case ",$(eni "$NEW_IP" | awk '{print $5}')," in
  *",$FIP,"*) echo "AWS shows $FIP on $NEW_ENI" ;;
  *) echo "WARNING: AWS does not show $FIP on $NEW_ENI" ;;
esac
STAGE=done

say "Timings"
echo "FAILOVER (writes blocked, then switched): $((T1 - T0))ms"
echo "assign-private-ip-addresses call: $((m1 - m0))ms"
if [ -n "$first" ]; then
  window=$((first - T0))
  echo "Writes unavailable (FAILOVER to the first client on $NEW): ${window}ms"
  [ -z "$all" ] || echo "All $CLIENTS clients on $NEW after: $((all - T0))ms"
  [ "$window" -le "$BUDGET_MS" ] || echo "WARNING: over the ${BUDGET_MS}ms budget: expect [LOCK COMPROMISED] restarts"
elif [ "$CLIENTS" -gt 0 ]; then
  echo "error: none of the $CLIENTS clients reached $NEW within ${CLIENT_WAIT}s, so Redis traffic may be down." >&2
  echo "Redis has switched and $FIP is on $NEW. Check the app host's neighbour entry for $FIP (ip neigh show $FIP;" >&2
  echo "ip neigh del $FIP dev <if>) and its Redis connections. Rollback: $ROLLBACK" >&2
  exit 1
else
  echo "No client reached $NEW within ${CLIENT_WAIT}s"
fi

say "Done: $NEW is the master"
echo "Rollback: $ROLLBACK"
backup=$(field "$NEW_INFO" cron_backup)
[ -z "$backup" ] || echo "Rolling back to $NEW also needs its old cron jobs back: ssh $NEW crontab $backup"
