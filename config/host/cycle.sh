#!/bin/bash
# Usage: cycle.sh --drill|--production [options] <phase> <old> <new>
#        cycle.sh --drill|--production [options] launch <old>
#        cycle.sh [options] status <old> <new>
#        cycle.sh --drill|--production [options] restore [<new>]
# Moves everything onto a fresh host: "build a new one and move onto it" is how
# this project upgrades a host. A thin wrapper over launch.sh, deploy.sh,
# data-volume/resize.sh, config/redis/promote.sh, scripts/deploy/units.sh and
# bans.sh. Read the "Host cycle" section of README.md first.
#
# Phases, in order. Each can be run alone and run again, and stops on a failed
# check. What it does next is decided by looking at the hosts, not a state file.
#   status     where a cycle stands; changes nothing
#   launch     launch.sh, then deploy.sh: Redis and the instance store, no units
#   replicate  the new Redis replicates the old one and has synced
#   data       resize.sh move prepare, deploy.sh with the new volume, move copy
#   app        pause deploys, env files, certificates, the old host's image on
#              the new host against its read-only replica, verify
#   switch     freeze, final copy, promote, wipe the cache, move the Elastic IP,
#              stop the old units, import permabans, unfreeze
#   settle     rolling deploy of the same image, verify, retag the volumes,
#              deploys resume
#   finish     after a few days: terminate the old hosts (by explicit ID only)
#
# restore is not part of a cycle: it is disaster recovery (#2261) for when the
# host is gone, with no old host to read from. See "Recovery" in README.md.
#   restore    launch a host, restore Redis from its newest backup, a new data
#              volume from the newest snapshot, the units, then the Elastic IP
#
# <old> and <new> are ssh names that work with plain `ssh <name>` as ec2-user,
# so put them in ~/.ssh/config: units.sh takes no ssh options. launch has no
# <new> to name yet; it prints the address to add.
#
# You have to say which world you are in: --drill needs every host tagged
# BlotDrill=true and old hosts marked /etc/blot/drill, --production refuses
# hosts with that tag. Nothing destructive has a default: the Elastic IP, the
# bans file and everything finish touches are passed in. The operator sets
# AWS_PROFILE and AWS_REGION, and launch.sh's own settings: BLOT_HOST_KEY_NAME,
# BLOT_HOST_SSH_KEY, BLOT_SSH_PORT and REDIS_MAXMEMORY (launch and data use the
# key too, for deploy.sh).
#
# Options:
#   --old-redis SSH_HOST    the old Redis host, when it is not <old> (the first
#                           cycle, from two hosts)
#   --old-direct SSH_HOST   a way to <old> that does not use the Elastic IP, needed
#                           from switch on: the old host has no other public
#                           address, so usually an alias of its private IP with
#                           ProxyJump through <new>. Default <old>
#   --eip eipalloc-...      the Elastic IP (switch, settle, status)
#   --bans-file FILE        where the permabans go between hosts (switch); must be
#                           ignored by git, so in data/
#   --verify-host HOST      a blog to check as well as the site, repeatable (app)
#   --type TYPE             instance type (launch)
#   --cycle NAME            a name for this cycle, tagged on the new host, which is
#                           how launch finds it when run again (launch)
#   --freeze-ttl SECONDS    freeze TTL, re-armed at each step of switch (default 900)
#   --any-time              allow the 01:00 and 05:00 UTC hours
#   --yes                   do not ask for confirmation
#   --dry-run               run the checks and print each step; change nothing
# restore only (everything it needs comes from here, none of it from an old host):
#   --old-volume vol-...    the lost data volume; its newest completed snapshot is used.
#                           The volume itself is never touched
#   --snapshot snap-...     a snapshot to use instead (or as well, to be sure of it)
#   --commit SHA            the 40-digit commit of the image to run
#   --secrets-env FILE      secrets.env and proxy.env as they were on the lost host,
#   --proxy-env FILE        kept off the host and out of the repo
#   --aws-credentials FILE  a credentials file with a [default] profile that can read the
#                           Redis backups and write new ones; goes to ec2-user's ~/.aws
#   --redis-backup NAME     a backup other than the newest (restore.sh's names)
#   --offsite PROFILE s3://BUCKET   restore Redis from the offsite copy instead, as restore.sh
#   --wait-prewarm          do not move the Elastic IP until the volume has loaded
#   plus --type, --cycle, --eip, and --bans-file (optional) as above
# finish only:
#   --old-instance i-...    a host to terminate, repeatable. Never <new>, never
#                           the holder of the Elastic IP, and termination
#                           protection is not lifted for you
#   --old-volume vol-...    the old data volume, kept, and checked to have been
#                           retagged by settle at least 3 days ago
#   --any-age               do not wait those 3 days
#
# Runs on a Mac, so it has to work in bash 3.2.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(dirname "$(dirname "$HERE")")

SOCKET=/run/blot/redis/redis.sock
PAUSE_FILE=/etc/blot/deploy-paused
FREEZE_REASON="data volume move" # resize.sh move thaw recognises its freeze by this
SYNC_TRIES=720                   # checks 10 seconds apart: two hours for the first sync
FINISH_MIN_DAYS=3
FRESH_REDIS_KEYS=10              # a fresh Redis holds only its samplers' keys (tcpmem-log.sh, redis-mem-log.sh)
UNIT_NAMES="blot-blue blot-green"
AIRLOCK_NAMES="blot-blue-airlock blot-green-airlock"

MODE=""; OLD_REDIS=""; OLD_DIRECT=""; EIP=""; BANS_FILE=""; VERIFY_HOSTS=""; TYPE=""; CYCLE=""
FREEZE_TTL=900; ANY_TIME=""; YES=""; DRY_RUN=""
OLD_INSTANCES=""; OLD_VOLUME=""; ANY_AGE=""
SNAPSHOT=""; COMMIT=""; SECRETS_FILE=""; PROXY_FILE=""; AWS_CREDS=""; REDIS_BACKUP=latest
OFFSITE_PROFILE=""; OFFSITE_BUCKET=""; WAIT_PREWARM=""
STAGE=""; IMAGE=""; EIP_SSH_DIR=""

die() { echo "error: $*" >&2; exit 1; }
say() { printf '\n==> %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --old-redis | --old-direct | --eip | --bans-file | --verify-host | --type | --cycle | --freeze-ttl | --old-instance | --old-volume | \
      --snapshot | --commit | --secrets-env | --proxy-env | --aws-credentials | --redis-backup | --offsite)
      [ $# -ge 2 ] || die "$1 needs a value" ;;
  esac
  case "$1" in
    --drill) [ "$MODE" != production ] || die "--drill or --production, not both"; MODE=drill; shift ;;
    --production) [ "$MODE" != drill ] || die "--drill or --production, not both"; MODE=production; shift ;;
    --old-redis) OLD_REDIS=$2; shift 2 ;;
    --old-direct) OLD_DIRECT=$2; shift 2 ;;
    --eip) EIP=$2; shift 2 ;;
    --bans-file) BANS_FILE=$2; shift 2 ;;
    --verify-host)
      [[ $2 =~ ^[A-Za-z0-9.-]+$ ]] || die "--verify-host takes a host name"
      VERIFY_HOSTS="$VERIFY_HOSTS $2"; shift 2 ;;
    --type) TYPE=$2; shift 2 ;;
    --cycle) CYCLE=$2; shift 2 ;;
    --freeze-ttl) FREEZE_TTL=$2; shift 2 ;;
    --old-instance) OLD_INSTANCES="$OLD_INSTANCES $2"; shift 2 ;;
    --old-volume) OLD_VOLUME=$2; shift 2 ;;
    --snapshot) SNAPSHOT=$2; shift 2 ;;
    --commit) COMMIT=$2; shift 2 ;;
    --secrets-env) SECRETS_FILE=$2; shift 2 ;;
    --proxy-env) PROXY_FILE=$2; shift 2 ;;
    --aws-credentials) AWS_CREDS=$2; shift 2 ;;
    --redis-backup) REDIS_BACKUP=$2; shift 2 ;;
    --offsite)
      [ $# -ge 3 ] || die "--offsite needs a read profile and an s3://bucket"
      OFFSITE_PROFILE=$2; OFFSITE_BUCKET=$3; shift 3 ;;
    --wait-prewarm) WAIT_PREWARM=1; shift ;;
    --any-age) ANY_AGE=1; shift ;;
    --any-time) ANY_TIME=1; shift ;;
    --yes) YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -*) die "unknown option $1" ;;
    *) break ;;
  esac
done
PHASE=${1:-}; OLD=${2:-}; NEW=${3:-}
[ $# -le 3 ] || die "unexpected argument $4"
USAGE="usage: cycle.sh --drill|--production [options] status|launch|replicate|data|app|switch|settle|finish <old> <new>
       cycle.sh --drill|--production [options] restore [<new>]"
case "$PHASE" in
  status | launch | replicate | data | app | switch | settle | finish) ;;
  # No old host: the one argument is the new host's ssh name, which does not
  # exist until the first run has launched it.
  restore) NEW=$OLD; OLD=""; [ $# -le 2 ] || die "restore takes at most the new host's name, not $3" ;;
  *) die "$USAGE" ;;
esac
[ -n "$OLD" ] || [ "$PHASE" = restore ] || die "$USAGE"
[ "$PHASE" = launch ] || [ "$PHASE" = restore ] || [ -n "$NEW" ] || die "$USAGE"
[ -n "$MODE" ] || [ "$PHASE" = status ] || die "say which: --drill (hosts tagged BlotDrill=true) or --production"
[ -n "${AWS_PROFILE:-}" ] && [ -n "${AWS_REGION:-}" ] || die "set AWS_PROFILE and AWS_REGION"
case "$FREEZE_TTL" in '' | *[!0-9]*) die "--freeze-ttl takes a number" ;; esac
[ "$FREEZE_TTL" -ge 300 ] || die "--freeze-ttl must be at least 300: resize.sh needs that for the final copy"
[ -z "$EIP" ] || [[ $EIP =~ ^eipalloc-[0-9a-f]+$ ]] || die "--eip takes an allocation ID, eipalloc-..."

OLD_DIRECT=${OLD_DIRECT:-$OLD}
# From switch on <old> may be an alias of the Elastic IP, which by then may reach
# the NEW host, so nothing there uses that name. Earlier nothing needs the jump.
case "$PHASE" in switch | settle | finish | status) OLD_NOW=$OLD_DIRECT ;; *) OLD_NOW=$OLD ;; esac
OLD_REDIS=${OLD_REDIS:-$OLD_NOW}

# ---- helpers -------------------------------------------------------------

# on <host> <command...>: run it there. pipe_to reads this script's stdin.
on() {
  local host=$1
  shift
  # shellcheck disable=SC2086
  ssh -n -o BatchMode=yes -o ConnectTimeout=15 ${SSH_OPTS:-} "$host" "$@"
}
pipe_to() {
  local host=$1
  shift
  # shellcheck disable=SC2086
  ssh -o BatchMode=yes -o ConnectTimeout=15 ${SSH_OPTS:-} "$host" "$@"
}
# act <command...>: a change. A dry run prints it instead.
act() {
  if [ -n "$DRY_RUN" ]; then echo "would run: $*"; else "$@"; fi
}
# need <message>: a check failed. On a dry run an earlier phase may not have
# happened yet, so it reports and goes on.
need() {
  if [ -n "$DRY_RUN" ]; then echo "a real run would stop here: $*"; else die "$*"; fi
}
confirm() {
  [ -z "$YES$DRY_RUN" ] || return 0
  local reply
  read -r -p "$1 Type yes: " reply || die "no answer (use --yes when not running interactively)"
  [ "$reply" = yes ] || die "aborted"
}
aws_cli() { aws --profile "$AWS_PROFILE" --region "$AWS_REGION" "$@"; }
ssh_config() { ssh -G "$1" | awk -v k="$2" '$1 == k {print $2; exit}'; }
instance_id() {
  on "$1" 'curl -s -m 2 -H "X-aws-ec2-metadata-token: $(curl -s -m 2 -X PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token)" http://169.254.169.254/latest/meta-data/instance-id' 2> /dev/null || true
}
primary_ip() { on "$1" "ip -4 -o route get 1.1.1.1" | sed -n 's/.* src \([0-9.]*\).*/\1/p'; }
redis_info() { on "$1" "redis6-cli INFO replication" 2> /dev/null | tr -d '\r' || true; }
info_field() { echo "$1" | sed -n "s/^$2://p" | head -n 1; }
docker_field() { on "$1" "sudo docker inspect -f '$3' $2" 2> /dev/null || true; }
env_value() { on "$1" "sudo sed -n 's/^$2=//p' /etc/blot/proxy.env | tail -n 1" 2> /dev/null || true; }

# The 01:00 UTC hour is the wildcard renewal and the 05:00 hour is when the host
# and the scheduler delete files. A quarter of an hour's margin before each, so a
# switch started just before does not run into them.
refuse_window() {
  case "$(date -u +%H%M)" in
    004[5-9] | 005? | 01?? | 044[5-9] | 045? | 05??)
      if [ -n "$ANY_TIME" ]; then echo "WARNING: inside the 01:00 or 05:00 UTC window (--any-time given)"
      elif [ -n "$DRY_RUN" ]; then echo "NOTE: a real run would refuse now: inside the 01:00 or 05:00 UTC window; --any-time overrides"
      else die "not within 15 minutes before or during the 01:00 and 05:00 UTC hours (wildcard renewal, file cleanup): wait, or pass --any-time"; fi ;;
  esac
}

# check_world <instance-id>: this instance belongs to the world we said we are in.
check_world() {
  local tag
  tag=$(aws_cli ec2 describe-instances --instance-ids "$1" \
    --query 'Reservations[0].Instances[0].Tags[?Key==`BlotDrill`]|[0].Value' --output text)
  if [ "$MODE" = drill ] && [ "$tag" != true ]; then
    die "--drill, but $1 is not tagged BlotDrill=true"
  elif [ "$MODE" = production ] && [ "$tag" = true ]; then
    die "--production, but $1 is tagged BlotDrill=true"
  fi
}

# guard: the hosts are what we think they are. OLD_ID and NEW_ID are read from
# the hosts themselves, because an alias of the Elastic IP changes host mid-cycle.
OLD_ID=""; NEW_ID=""; REDIS_ID=""
guard() {
  local eip_address
  # After the move the launch address is gone, so <new> may reach nothing until
  # the alias is edited, and --old-direct jumps through <new>: follow the
  # Elastic IP, as phase_switch does, before the first probe of either host.
  if [ -n "$NEW" ] && [ -n "$EIP" ] && { [ "$PHASE" = switch ] || [ "$PHASE" = settle ]; }; then
    NEW_ID=$(instance_id "$NEW")
    if [ -z "$NEW_ID" ]; then
      eip_address=$(aws_cli ec2 describe-addresses --allocation-ids "$EIP" --query 'Addresses[0].PublicIp' --output text)
      follow_eip "$eip_address"
    fi
  fi
  OLD_ID=$(instance_id "$OLD_NOW")
  [ -n "$OLD_ID" ] || die "cannot reach $OLD_NOW"
  check_world "$OLD_ID"
  if [ -n "$NEW" ]; then
    NEW_ID=$(instance_id "$NEW")
    if [ -z "$NEW_ID" ]; then
      need "cannot reach $NEW"
    else
      check_world "$NEW_ID"
      [ "$OLD_ID" != "$NEW_ID" ] || die "$OLD_NOW and $NEW are the same instance, $NEW_ID: is one an alias of the Elastic IP?"
    fi
  fi
  if [ "$MODE" = drill ]; then
    on "$OLD_NOW" "test -e /etc/blot/drill" || die "--drill, but $OLD_NOW has no /etc/blot/drill: resize.sh would treat it as production"
  fi
  # --old-redis is another host that switch runs CONFIG SET and FAILOVER on, so
  # it gets the same checks. status only reads, and finish names its instances
  # by ID and never touches Redis, so neither needs this.
  if [ "$OLD_REDIS" != "$OLD_NOW" ]; then
    REDIS_ID=$(instance_id "$OLD_REDIS")
    [ -n "$REDIS_ID" ] || die "cannot reach $OLD_REDIS"
    check_world "$REDIS_ID"
    if [ "$MODE" = drill ]; then
      on "$OLD_REDIS" "test -e /etc/blot-redis/drill" || die "--drill, but $OLD_REDIS has no /etc/blot-redis/drill: promote.sh would treat it as production"
    fi
  fi
}

# Never go back past the switch: REPLICAOF would wipe a promoted Redis, and a
# copy or a fresh deploy would write over what the new host now serves.
refuse_after_switch() {
  local info keys
  info=$(redis_info "$NEW")
  [ "$(info_field "$info" role)" = master ] || return 0
  keys=$(on "$NEW" "redis6-cli DBSIZE" | tr -d '\r')
  [ "$keys" -le "$FRESH_REDIS_KEYS" ] || die "$NEW's Redis is a master with $keys keys, more than a fresh one holds ($FRESH_REDIS_KEYS): it has been promoted, or was never empty. Nothing before switch runs on it"
}

rs() {
  local flags="--profile $AWS_PROFILE --region $AWS_REGION --host $OLD_NOW --app-freeze --freeze-ttl $FREEZE_TTL"
  [ -z "$ANY_TIME" ] || flags="$flags --any-time"
  [ -z "$YES" ] || flags="$flags --yes"
  [ -z "$DRY_RUN" ] || flags="$flags --dry-run"
  # shellcheck disable=SC2086
  "$HERE/data-volume/resize.sh" $flags "$@"
}

deploy_host() { # deploy_host <address> [volume]
  SSH_KEY=$BLOT_HOST_SSH_KEY PUBLIC_IP=$1 SSH_PORT=${BLOT_SSH_PORT:-22} DATA_VOLUME_ID=${2:-} "$HERE/deploy.sh"
}

# units_ok <host>: both units are healthy and on the socket. Prints what is not.
units_ok() {
  local u problem=""
  for u in $UNIT_NAMES; do
    [ "$(docker_field "$1" "$u" '{{.State.Health.Status}}')" = healthy ] || problem="$problem $u is not healthy."
    docker_field "$1" "$u" '{{json .Config.Env}}' | grep -q "BLOT_REDIS_SOCKET=$SOCKET" ||
      problem="$problem $u is not on the Redis socket."
  done
  [ -z "$problem" ] || { echo "$problem"; return 1; }
}

# old_image: the image both old units run. app has to use the same one: a new
# one could bring a template change, which cannot be written to a replica, and
# that step is not retried.
old_image() {
  local blue green
  blue=$(docker_field "$OLD_NOW" blot-blue '{{.Config.Image}}')
  green=$(docker_field "$OLD_NOW" blot-green '{{.Config.Image}}')
  [ -n "$blue" ] && [ "$blue" = "$green" ] || die "blot-blue ($blue) and blot-green ($green) on $OLD_NOW do not run one image: finish that deploy first"
  [[ ${blue##*:} =~ ^[0-9a-f]{40}$ ]] || die "cannot tell the commit of $blue on $OLD_NOW"
  echo "$blue"
}

probe() { # probe <ip> <host> <path>: the status of that request, from the new host
  on "$NEW" "curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --resolve $2:443:$1 https://$2$3" 2> /dev/null || echo 000
}
probe_public() { # probe_public <ip> <host> <path>: the same, from here
  curl -sS -o /dev/null -w '%{http_code}' --max-time 15 --resolve "$2:443:$1" "https://$2$3" 2> /dev/null || echo 000
}
# wait_public_health <ip> <host>: an association takes a few seconds to reach the instance.
wait_public_health() {
  local i code=000
  for i in $(seq 20); do
    code=$(probe_public "$1" "$2" /health)
    [ "$code" = 200 ] && break
    [ "$i" = 20 ] || sleep 3
  done
  [ "$code" = 200 ] || die "https://$2/health through $1 answered $code"
}

# ---- launch --------------------------------------------------------------

# The new host has no ssh alias yet, and a new instance reuses addresses, so do
# not record its host key.
new_host_ssh() { echo "-i ${BLOT_HOST_SSH_KEY:-} -p ${BLOT_SSH_PORT:-22} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"; }

# resize.sh and promote.sh read these to tell a drill from production.
mark_drill() {
  SSH_OPTS=$(new_host_ssh) on "ec2-user@$1" "sudo mkdir -p /etc/blot /etc/blot-redis && sudo touch /etc/blot/drill /etc/blot-redis/drill"
}

phase_launch() {
  local found id address drill_flag=""
  [ -n "$TYPE" ] || die "launch needs --type"
  [ -n "$CYCLE" ] || die "launch needs --cycle NAME, the tag that finds this host if you run it again"
  [[ $CYCLE =~ ^[A-Za-z0-9._-]+$ ]] || die "--cycle takes letters, digits, dots, dashes and underscores"
  [ -n "${BLOT_HOST_SSH_KEY:-}" ] || [ -n "$DRY_RUN" ] || die "set BLOT_HOST_SSH_KEY: the private key for the new host"
  [ "$MODE" != drill ] || drill_flag=--drill

  found=$(aws_cli ec2 describe-instances \
    --filters "Name=tag:BlotCycle,Values=$CYCLE" "Name=instance-state-name,Values=pending,running" \
    --query 'Reservations[].Instances[].[InstanceId,PublicIpAddress]' --output text)
  [ "$(printf '%s\n' "$found" | grep -c .)" -le 1 ] || die "several instances are tagged BlotCycle=$CYCLE: $found"

  if [ -n "$found" ]; then
    id=$(echo "$found" | awk '{print $1}'); address=$(echo "$found" | awk '{print $2}')
    say "$id is already this cycle's new host: setting it up again"
    check_world "$id"
    [ -n "${BLOT_DEPLOY_PUBLIC_KEY:-}" ] || [ ! -f "$HOME/.ssh/blot-deploy.pub" ] || BLOT_DEPLOY_PUBLIC_KEY=$(cat "$HOME/.ssh/blot-deploy.pub")
    act env SSH_OPTS="$(new_host_ssh)" \
      REDIS_MAXMEMORY="${REDIS_MAXMEMORY:-}" BLOT_SSH_PORT="${BLOT_SSH_PORT:-}" BLOT_DEPLOY_PUBLIC_KEY="${BLOT_DEPLOY_PUBLIC_KEY:-}" \
      "$HERE/bootstrap.sh" "ec2-user@$address"
  elif [ -n "$DRY_RUN" ]; then
    # shellcheck disable=SC2086
    "$HERE/launch.sh" --profile "$AWS_PROFILE" --region "$AWS_REGION" --type "$TYPE" --tag "BlotCycle=$CYCLE" $drill_flag --dry-run
    echo "would run: deploy.sh on the new host"
    return 0
  else
    say "Launching a $TYPE"
    # shellcheck disable=SC2086
    "$HERE/launch.sh" --profile "$AWS_PROFILE" --region "$AWS_REGION" --type "$TYPE" --tag "BlotCycle=$CYCLE" $drill_flag
    found=$(aws_cli ec2 describe-instances \
      --filters "Name=tag:BlotCycle,Values=$CYCLE" "Name=instance-state-name,Values=running" \
      --query 'Reservations[].Instances[].[InstanceId,PublicIpAddress]' --output text)
    id=$(echo "$found" | awk '{print $1}'); address=$(echo "$found" | awk '{print $2}')
    [ -n "$address" ] && [ "$address" != None ] || die "cannot find the public address of the instance tagged BlotCycle=$CYCLE"
  fi

  [ "$MODE" != drill ] || act mark_drill "$address"
  say "deploy.sh, without a data volume yet: the instance store and the host's files"
  act deploy_host "$address"

  if [ -z "$DRY_RUN" ]; then
    SSH_OPTS=$(new_host_ssh) on "ec2-user@$address" "systemctl is-active --quiet redis6 && mountpoint -q /var/instance-ssd" ||
      die "$id is up, but redis6 is not running or the instance store is not mounted"
  fi
  say "Done: $id at $address"
  echo "Add it to ~/.ssh/config (Host <name>, HostName $address, User ec2-user, Port, IdentityFile), then:"
  if [ "$PHASE" = restore ]; then echo "  run the same restore command again, with <name> on the end"
  else echo "  $0 --$MODE replicate $OLD <name>"; fi
}

# ---- replicate -----------------------------------------------------------

phase_replicate() {
  local info role primary link i
  refuse_after_switch
  primary=$(primary_ip "$OLD_REDIS")
  [ -n "$primary" ] || die "cannot find the primary IP of $OLD_REDIS"
  [ "$(info_field "$(redis_info "$OLD_REDIS")" role)" = master ] || die "$OLD_REDIS is not a Redis master"

  info=$(redis_info "$NEW")
  role=$(info_field "$info" role)
  if [ "$role" = slave ] && [ "$(info_field "$info" master_host)" = "$primary" ]; then
    echo "$NEW already replicates from $primary"
  elif [ "$role" = slave ]; then
    die "$NEW replicates from $(info_field "$info" master_host), not $primary. promote.sh needs the old host's own address"
  else
    say "Replicating $NEW from $primary"
    # From redis/launch.sh: a full sync under write load overflows 6.2's default
    # replica output buffer, and the sync starts over, again and again.
    act on "$NEW" "redis6-cli -h $primary CONFIG SET client-output-buffer-limit 'replica 1073741824 536870912 120' | grep -qx OK"
    act on "$NEW" "redis6-cli REPLICAOF $primary 6379 | grep -qx OK"
  fi

  [ -z "$DRY_RUN" ] || { echo "would wait for master_link_status:up"; return 0; }
  echo "Waiting for the sync"
  for i in $(seq 1 "$SYNC_TRIES"); do
    info=$(redis_info "$NEW")
    link=$(info_field "$info" master_link_status)
    [ "$link" = up ] && break
    [ "$i" = "$SYNC_TRIES" ] || sleep 10
  done
  [ "$link" = up ] || die "$NEW has not synced yet (link $link); it is still replicating, run this again to go on waiting"
  echo "$NEW is in sync with $primary. It stays a replica until switch."
}

# ---- data ----------------------------------------------------------------

phase_data() {
  local volume
  [ -n "${BLOT_HOST_SSH_KEY:-}" ] || [ -n "$DRY_RUN" ] || die "set BLOT_HOST_SSH_KEY: deploy.sh needs it"
  refuse_after_switch
  say "Preparing the new volume"
  rs move prepare --to "$NEW"
  if [ -n "$DRY_RUN" ]; then
    echo "would run: deploy.sh on $NEW with DATA_VOLUME_ID from move status"
  else
    volume=$(rs move status | sed -n 's/^Move: .* -> \(vol-[0-9a-f]*\) at .*/\1/p')
    [ -n "$volume" ] || die "move status on $OLD_NOW names no new volume"
    say "deploy.sh with $volume"
    deploy_host "$(ssh_config "$NEW" hostname)" "$volume"
  fi
  say "Live copy passes"
  rs move copy
  [ -n "$DRY_RUN" ] || [ "$(on "$NEW" "sudo cat /var/www/blot/data/.blot-data-volume" | tr -d '\r')" = "$volume" ] ||
    die "$NEW's data directory does not carry the marker of $volume"
}

# ---- app -----------------------------------------------------------------

# Runs on the new host as root, with the two env files as a tar on stdin. $1 is
# the socket. Prints "changed" for a file it replaced.
ENV_SCRIPT=$(cat << 'EOF'
set -eu
umask 077
tmp=$(mktemp -d /etc/blot/.cycle.XXXXXX)
trap 'rm -rf "$tmp"' EXIT
tar -C "$tmp" -xpf -
set_value() { sed "/^\(export \)\{0,1\}$2=/d" "$1" > "$1.new"; cat "$1.new" > "$1"; rm -f "$1.new"; echo "$2=$3" >> "$1"; }
set_value "$tmp/secrets.env" BLOT_REDIS_SOCKET "$1"
set_value "$tmp/proxy.env" PROXY_REDIS_HOST "unix:$1"
# common.sh refuses a key that the two files set differently.
if grep -Eq '^(export )?PROXY_REDIS_HOST=' "$tmp/secrets.env"; then
  set_value "$tmp/secrets.env" PROXY_REDIS_HOST "unix:$1"
fi
for f in secrets.env proxy.env; do
  if ! cmp -s "$tmp/$f" "/etc/blot/$f"; then
    mv -f "$tmp/$f" "/etc/blot/$f"
    # On the host, not in this script's memory: if the forced deploy fails, the
    # next run finds the files current and would skip units that hold the old env.
    touch /etc/blot/cycle-env-pending
    echo changed
  fi
done
# setup-deploy-user.sh ran before these files existed.
setfacl -m u:deploy:r,u:ec2-user:r /etc/blot/secrets.env /etc/blot/proxy.env
runuser -u deploy -- test -r /etc/blot/proxy.env
runuser -u deploy -- test -r /etc/blot/secrets.env
EOF
)

# copy_env: the files go straight from the old host to the new one through this
# pipe, so they never land on this machine, and the socket settings go in the new
# host's copy only: the old units keep reaching Redis as they do. Sets ENV_CHANGED.
ENV_CHANGED=""
copy_env() {
  local out
  out=$(on "$OLD_NOW" "sudo tar -C /etc/blot -cf - secrets.env proxy.env" |
    pipe_to "$NEW" "sudo bash -c $(printf %q "$ENV_SCRIPT") cycle $SOCKET") ||
    die "could not copy the env files from $OLD_NOW to $NEW, or deploy cannot read them"
  case "$out" in *changed*) ENV_CHANGED=1 ;; esac
  # phase_app removes the marker once the units are verified.
  ! on "$NEW" "test -e /etc/blot/cycle-env-pending" || ENV_CHANGED=1
  echo "Env files on $NEW: $([ -n "$ENV_CHANGED" ] && echo updated || echo already current), on the Redis socket"
}

# copy_backup_config: backup.sh on the new host uses ~ec2-user/.aws (it has no
# instance profile, see #2261) and the offsite bucket file. A drill gets neither,
# so it can never upload to the real buckets.
copy_backup_config() {
  [ "$MODE" = production ] || { echo "Drill: no backup credentials copied"; return 0; }
  local bucket
  if on "$OLD_REDIS" 'test -d "$HOME/.aws"'; then
    on "$OLD_REDIS" 'tar -C "$HOME" -cf - .aws' | pipe_to "$NEW" 'umask 077; tar -C "$HOME" -xf -'
  fi
  bucket=$(on "$OLD_REDIS" "sudo cat /etc/blot-redis/offsite-bucket 2> /dev/null" || true)
  [ -z "$bucket" ] || echo "$bucket" | pipe_to "$NEW" "sudo tee /etc/blot-redis/offsite-bucket > /dev/null"
  on "$NEW" "aws sts get-caller-identity > /dev/null" ||
    die "ec2-user on $NEW has no working AWS credentials, so it could not back up after the switch: put the blot key in ~/.aws there (an instance profile on $OLD_REDIS does not copy), then run app again"
}

pause_deploys() {
  local h
  for h in "$@"; do
    on "$h" "sudo mkdir -p /etc/blot && echo 'host cycle $OLD to $NEW' | sudo tee $PAUSE_FILE > /dev/null" ||
      die "could not pause deploys on $h"
  done
}

phase_app() {
  local info sha airlock problem address host code
  refuse_after_switch
  info=$(redis_info "$NEW")
  [ "$(info_field "$info" role)" = slave ] && [ "$(info_field "$info" master_link_status)" = up ] ||
    need "$NEW's Redis is not a replica with its link up: run replicate first"
  on "$NEW" "mountpoint -q /var/www/blot/data && mountpoint -q /var/instance-ssd" ||
    need "the data volume or the instance store is not mounted on $NEW: run data first"

  say "Pausing deploys on $OLD_NOW and $NEW"
  act pause_deploys "$OLD_NOW" "$NEW"
  on "$OLD_NOW" 'f=/tmp/blot-proxy-deploy.lock; [ ! -e "$f" ] || flock -n "$f" true' ||
    need "a deploy is running on $OLD_NOW: wait for it, then run app again"

  IMAGE=$(old_image); sha=${IMAGE##*:}
  airlock=$(docker_field "$OLD_NOW" blot-blue-airlock '{{.Config.Image}}')
  echo "Image: $IMAGE"

  say "Env files, backup settings and the wildcard certificate"
  act copy_env
  act copy_backup_config
  act "$HERE/wildcard-cert.sh" "$NEW"

  # docker stays off on a new host until the two disks are there (see README.md).
  say "Starting the units on $NEW against its read-only replica"
  act on "$NEW" "sudo systemctl start docker"
  # A unit only reads the env files when it is created, so edited ones mean
  # replacing it even though it already runs this image.
  act env BLOT_DEPLOY_TARGET="$NEW" PROXY_DEPLOY_IGNORE_PAUSE=1 PROXY_VERIFY_SKIP_REDIS_WRITE=1 \
    PROXY_AIRLOCK_IMAGE="$airlock" PROXY_DEPLOY_FORCE="${ENV_CHANGED:+1}" "$ROOT/scripts/deploy/units.sh" "$sha"

  [ -z "$DRY_RUN" ] || { echo "would check the units and curl the site through $NEW's private IP"; return 0; }
  problem=$(units_ok "$NEW") || die "$problem"
  address=$(primary_ip "$NEW")
  host=$(env_value "$NEW" BLOT_HOST)
  [ -n "$host" ] || die "no BLOT_HOST in $NEW's proxy.env"
  code=$(probe "$address" "$host" /health)
  [ "$code" = 200 ] || die "https://$host/health through $address answered $code"
  # Custom domains' certificates: blue-green.sh's fresh start served every one.
  for host in $host $VERIFY_HOSTS; do
    code=$(probe "$address" "$host" /)
    [ "$code" = 200 ] || die "https://$host/ through $address answered $code"
    echo "$host answers 200 through $address"
  done
  # A file from the host's static directory, which every deploy fills from the
  # image: the cdn. server block serves it from disk and sends a miss to Node.
  host=$(env_value "$NEW" BLOT_HOST)
  code=$(probe "$address" "cdn.$host" /layout.css)
  [ "$code" = 200 ] || die "https://cdn.$host/layout.css through $address answered $code: the static directory on $NEW is not filled"
  act on "$NEW" "sudo rm -f /etc/blot/cycle-env-pending"
  echo "The units on $NEW are up. Dashboard pages may fail until the switch: sessions need writes."
}

# ---- switch --------------------------------------------------------------

rearm() { # rearm <host whose Redis is the master>: the TTL clock starts again
  act on "$1" "sudo docker exec blot-blue node scripts/read-only.js on --ttl $FREEZE_TTL --reason '$FREEZE_REASON' > /dev/null"
}

# Holds the deploy lock, because the health cron restarts a unit that goes
# unhealthy while it drains (see check_docker_health.sh). The lock is opened
# read-only, as in acquire_lock in proxy/deploy/common.sh. The containers are
# stopped, not removed: they are the rollback.
stop_old_units() {
  on "$OLD_NOW" "sudo bash -c 'f=/tmp/blot-proxy-deploy.lock; [ -e \$f ] || touch \$f; exec 9< \$f; flock -w 300 9; docker stop --time 40 $UNIT_NAMES $AIRLOCK_NAMES > /dev/null'"
  [ -z "$(on "$OLD_NOW" "sudo docker ps -q --filter name=^blot-")" ] || die "containers are still running on $OLD_NOW"
}

unfreeze() {
  local out
  out=$(on "$NEW" "sudo docker exec blot-blue node scripts/read-only.js off" | grep '^{')
  echo "$out" | grep -q '"readOnly":null' || die "the freeze is still on: $out"
}

# follow_eip <eip address>: once the Elastic IP is on <new>, its launch-time
# address is released and <new> (an alias of that address) reaches nothing, but
# every child script calls plain `ssh <name>`. So put an ssh in front on PATH
# that overrides <new>'s HostName; ssh keeps the first value it reads, and passes
# -F on to a ProxyJump. HostKeyAlias keeps checking the host key under the
# alias's own known_hosts entry, not the old host's key under the Elastic IP.
follow_eip() {
  local original real
  [ -z "$EIP_SSH_DIR" ] || return 0
  [ -n "$1" ] && [ "$1" != None ] || return 0
  original=$(ssh_config "$NEW" hostname)
  [ "$original" != "$1" ] || return 0
  real=$(command -v ssh)
  EIP_SSH_DIR=$(mktemp -d)
  printf 'Host %s\n  HostName %s\n  HostKeyAlias %s\n\nHost *\n  Include %s/.ssh/config\n' "$NEW" "$1" "$original" "$HOME" > "$EIP_SSH_DIR/config"
  printf '#!/bin/sh\nexec %s -F %s "$@"\n' "$real" "$EIP_SSH_DIR/config" > "$EIP_SSH_DIR/ssh"
  chmod +x "$EIP_SSH_DIR/ssh"
  export PATH="$EIP_SSH_DIR:$PATH"
  echo "ssh to $NEW now goes to the Elastic IP $1 (its launch address is released)"
}

# The state, and the way on or back, for whatever stage switch stopped in.
explain() {
  local status=$?
  [ -z "$EIP_SSH_DIR" ] || rm -rf "$EIP_SSH_DIR"
  [ "$status" != 0 ] && [ -n "$STAGE" ] || return "$status"
  {
    echo
    echo "switch stopped during: $STAGE"
    case "$STAGE" in
      "freeze and final copy")
        echo "$OLD_REDIS is still the Redis master and the Elastic IP has not moved. resize.sh undoes a failed freeze"
        echo "unless the final copy finished. Check: resize.sh --host $OLD_NOW move status"
        echo "On: run switch again. Back: resize.sh --host $OLD_NOW move thaw" ;;
      promotion)
        echo "Frozen, and the old disk is read-only. promote.sh said above which host is the master."
        echo "On: run switch again. Back, if $OLD_REDIS is still the master: resize.sh --host $OLD_NOW move thaw" ;;
      *)
        echo "$NEW's Redis is the master. The app stays frozen until the TTL (${FREEZE_TTL}s from the last re-arm), and"
        echo "writes that land after that fail until the switch finishes, so be quick."
        echo "On: run switch again; it skips what is done."
        echo "Back: README.md, \"Rollback\". Only if $NEW has accepted no writes: promote.sh $NEW $OLD_REDIS, the Elastic IP"
        echo "back to $OLD_ID, start the old units, then resize.sh --host $OLD_NOW move thaw. After writes, first thaw"
        echo "$OLD_NOW (resize.sh --host $OLD_NOW move thaw) and keep $NEW primary until the reverse copy and freeze are"
        echo "done (data-volume/README.md), then Redis, then the Elastic IP, then start the old units." ;;
    esac
  } >&2
  return "$status"
}
trap explain EXIT

phase_switch() {
  local old_info eip_line eip_on eip_address role old_address resolved problem host code t0 i
  [ -n "$EIP" ] || die "switch needs --eip"
  [ -n "$BANS_FILE" ] || die "switch needs --bans-file, in the gitignored data/ directory"
  [ -d "$(dirname "$BANS_FILE")" ] || die "no such directory: $(dirname "$BANS_FILE")"
  git -C "$(dirname "$BANS_FILE")" check-ignore -q "$(basename "$BANS_FILE")" || die "$BANS_FILE is not ignored by git: the list of banned ranges stays out of the repo"

  say "Checks, before anything is frozen"
  aws_cli sts get-caller-identity > /dev/null || die "the AWS session has expired: moving the Elastic IP would fail half way"
  eip_line=$(aws_cli ec2 describe-addresses --allocation-ids "$EIP" --query 'Addresses[0].[InstanceId,PublicIp]' --output text)
  read -r eip_on eip_address <<< "$eip_line"
  # This is what keeps a drill away from the real address: it is on neither host.
  [ "$eip_on" = "$OLD_ID" ] || [ "$eip_on" = "$NEW_ID" ] || die "$EIP is on $eip_on, which is neither $OLD_NOW ($OLD_ID) nor $NEW ($NEW_ID)"
  # A resumed switch: the move is done and the launch address may be gone.
  [ "$eip_on" != "$NEW_ID" ] || follow_eip "$eip_address"

  old_address=$(ssh_config "$OLD_NOW" hostname)
  resolved=$(perl -MSocket -e '$a = inet_aton(shift); print $a ? inet_ntoa($a) : ""' "$old_address")
  [ "$resolved" != "$eip_address" ] || die "$OLD_NOW is the Elastic IP, which stops reaching the old host half way through. Pass --old-direct: an ssh alias of its private IP with ProxyJump through $NEW"

  problem=$(units_ok "$NEW") || need "$NEW: $problem"
  IMAGE=$(docker_field "$NEW" blot-blue '{{.Config.Image}}')
  [ "$IMAGE" = "$(old_image)" ] || need "$NEW runs $IMAGE, not the old host's image: run app"
  on "$NEW" "test -e $PAUSE_FILE" || need "deploys are not paused on $NEW: run app"
  host=$(env_value "$NEW" BLOT_HOST)
  [ -n "$host" ] || need "no BLOT_HOST in $NEW's proxy.env"
  code=$(probe "$(primary_ip "$NEW")" "cdn.$host" /layout.css)
  [ "$code" = 200 ] || need "https://cdn.$host/layout.css through $NEW answered $code: run app again"

  role=$(info_field "$(redis_info "$NEW")" role)
  # Running it again after it finished must not freeze the live site.
  if [ "$role" = master ] && [ "$eip_on" = "$NEW_ID" ] && [ -z "$(on "$OLD_NOW" "sudo docker ps -q --filter name=^blot-")" ] &&
    on "$NEW" "sudo docker exec blot-blue node scripts/read-only.js status" | grep -q '"readOnly":null'; then
    echo "The switch has finished: $NEW has the Elastic IP, its Redis is the master and nothing is frozen. Next: settle"
    return 0
  fi
  if [ "$role" != master ]; then
    "$ROOT/config/redis/promote.sh" --dry-run "$OLD_REDIS" "$NEW" || die "promote.sh would refuse; nothing has changed"
  fi
  # Only a promotion by this cycle leaves a master here, and promote.sh can
  # finish FAILOVER and die before it writes /etc/blot-redis/active, so read
  # the roles, not the marker.
  if [ "$role" = master ]; then
    old_info=$(redis_info "$OLD_REDIS")
    [ "$(info_field "$old_info" role)" = slave ] && [ "$(info_field "$old_info" master_host)" = "$(primary_ip "$NEW")" ] ||
      need "$NEW's Redis is a master that $OLD_REDIS does not follow, so it was not promoted by this cycle"
  fi
  # Now, while <old> still answers, so a later failure has not lost the list.
  act "$HERE/bans.sh" export "$OLD_NOW" "$BANS_FILE"

  cat << EOF

 1. freeze, final copy (resize.sh move freeze), writes stop here
 2. promote $NEW's Redis, $OLD_REDIS becomes its replica
 3. empty the proxy cache on $NEW
 4. $EIP ($eip_address) to $NEW_ID
 5. stop the units on $OLD_NOW, import permabans on $NEW
 6. check $host through the Elastic IP, lift the freeze
EOF
  confirm "Switch to $NEW?"
  YES=1 # asked once, here: a prompt must not eat into the freeze
  t0=$(date +%s)

  # A master here was promoted by this cycle (checked above), so the freeze was done.
  if [ "$role" != master ]; then
    STAGE="freeze and final copy"
    say "1. Freeze and final copy"
    rs move freeze
    rearm "$OLD_NOW"

    STAGE=promotion
    say "2. Promote"
    if [ -n "$DRY_RUN" ]; then echo "would run: promote.sh --yes $OLD_REDIS $NEW"
    else "$ROOT/config/redis/promote.sh" --yes "$OLD_REDIS" "$NEW"; fi
  fi
  STAGE="after the promotion"
  rearm "$NEW"
  # promote.sh can finish FAILOVER and die before it writes the markers, and
  # backup.sh skips a host without one. Here the promotion is this cycle's
  # (checked above or just done), so make both right, as promote.sh does.
  act on "$NEW" "sudo touch /etc/blot-redis/active"
  act on "$OLD_REDIS" "sudo rm -f /etc/blot-redis/active"

  if [ "$eip_on" != "$NEW_ID" ]; then
    say "3. Emptying the proxy cache on $NEW"
    act on "$NEW" "\$HOME/proxy-deploy/reset-cache.sh ${IMAGE##*:}"
    rearm "$NEW"

    say "4. Moving $EIP to $NEW_ID"
    act aws_cli ec2 associate-address --allocation-id "$EIP" --instance-id "$NEW_ID" --allow-reassociation
    if [ -z "$DRY_RUN" ]; then
      [ "$(aws_cli ec2 describe-addresses --allocation-ids "$EIP" --query 'Addresses[0].InstanceId' --output text)" = "$NEW_ID" ] ||
        die "$EIP is not on $NEW_ID"
      follow_eip "$eip_address"
    fi
  fi

  say "5. Stopping the units on $OLD_NOW, importing permabans"
  rearm "$NEW"
  act stop_old_units
  act "$HERE/bans.sh" import "$NEW" "$BANS_FILE"

  say "6. Checking and unfreezing"
  if [ -z "$DRY_RUN" ]; then
    wait_public_health "$eip_address" "$host"
  fi
  act unfreeze
  STAGE=""
  say "Switched in $(($(date +%s) - t0))s: $NEW serves $eip_address and takes writes. Next: settle"
  echo "Before finish, change HostName for $NEW in ~/.ssh/config to $eip_address: its launch address is released."
}

# ---- settle --------------------------------------------------------------

phase_settle() {
  local eip_on eip_address host code problem
  [ -n "$EIP" ] || die "settle needs --eip"
  read -r eip_on eip_address <<< "$(aws_cli ec2 describe-addresses --allocation-ids "$EIP" --query 'Addresses[0].[InstanceId,PublicIp]' --output text)"
  [ "$eip_on" = "$NEW_ID" ] || need "$EIP is not on $NEW: run switch"
  follow_eip "$eip_address"
  [ "$(info_field "$(redis_info "$NEW")" role)" = master ] || need "$NEW's Redis is not the master: run switch"
  host=$(env_value "$NEW" BLOT_HOST)

  if on "$NEW" "test -e $PAUSE_FILE"; then
    IMAGE=$(docker_field "$NEW" blot-blue '{{.Config.Image}}')
    # Forced: units already on this image would be skipped, and the point is the
    # once-at-boot steps that failed on the replica (onceAtStartup, folders()).
    say "Rolling deploy of ${IMAGE##*:} on $NEW"
    act env BLOT_DEPLOY_TARGET="$NEW" PROXY_DEPLOY_IGNORE_PAUSE=1 PROXY_DEPLOY_FORCE=1 \
      PROXY_AIRLOCK_IMAGE="$(docker_field "$NEW" blot-blue-airlock '{{.Config.Image}}')" "$ROOT/scripts/deploy/units.sh" "${IMAGE##*:}"
  else
    echo "Deploys are not paused on $NEW: the rolling deploy has happened"
  fi

  if [ -z "$DRY_RUN" ]; then
    problem=$(units_ok "$NEW") || die "$NEW: $problem"
    code=$(probe_public "$eip_address" "$host" /sites/log-in)
    [ "$code" = 200 ] || die "the dashboard, https://$host/sites/log-in, answered $code"
  fi

  say "Volumes: the new one takes the production name"
  rs move retag

  say "Deploys can resume"
  act on "$NEW" "sudo rm -f $PAUSE_FILE"
  act on "$OLD_NOW" "sudo rm -f $PAUSE_FILE"
  say "Settled. Keep the old host for a few days as the rollback, then: finish"
}

# ---- finish --------------------------------------------------------------

phase_finish() {
  local id tag protection state replaced age new_id eip_instance volume_attached delete_on_term master
  [ -n "$OLD_INSTANCES" ] || die "finish terminates what you name and nothing else: pass --old-instance i-... (repeatable)"
  [ -n "$OLD_VOLUME" ] || die "finish needs --old-volume vol-...: the old data volume, to check it was retagged"
  [ -n "$EIP" ] || die "finish needs --eip, to check what holds it"
  new_id=$(instance_id "$NEW")
  [ -n "$new_id" ] || die "cannot reach $NEW"
  master=$(info_field "$(redis_info "$NEW")" role)
  [ "$master" = master ] || die "$NEW's Redis is not the master"
  eip_instance=$(aws_cli ec2 describe-addresses --allocation-ids "$EIP" --query 'Addresses[0].InstanceId' --output text)
  [ "$eip_instance" = "$new_id" ] || die "$EIP is not on $NEW ($new_id)"
  on "$NEW" "test ! -e $PAUSE_FILE" || die "deploys are still paused on $NEW: run settle first"

  replaced=$(aws_cli ec2 describe-volumes --volume-ids "$OLD_VOLUME" --query 'Volumes[0].Tags[?Key==`BlotDataVolumeReplacedAt`]|[0].Value' --output text)
  [ -n "$replaced" ] && [ "$replaced" != None ] || die "$OLD_VOLUME has no BlotDataVolumeReplacedAt tag: it is not the volume settle replaced"
  if [ -z "$ANY_AGE" ]; then
    # perl: BSD and GNU date disagree on parsing a date
    age=$(perl -MTime::Local -e '@t = $ARGV[0] =~ /(\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)/ or exit 1; print int((time - timegm($t[5], $t[4], $t[3], $t[2], $t[1] - 1, $t[0])) / 86400)' "$replaced")
    [ "$age" -ge "$FINISH_MIN_DAYS" ] || die "$OLD_VOLUME was replaced $age day(s) ago: keep the rollback for $FINISH_MIN_DAYS days, or pass --any-age"
  fi
  volume_attached=$(aws_cli ec2 describe-volumes --volume-ids "$OLD_VOLUME" --query 'Volumes[0].Attachments[0].[InstanceId,DeleteOnTermination]' --output text)
  delete_on_term=$(echo "$volume_attached" | awk '{print $2}')
  [ "$delete_on_term" != True ] && [ "$delete_on_term" != true ] || die "$OLD_VOLUME is set to be deleted with its instance. It stays until someone decides otherwise: fix that first"

  # Every check for every instance before the first one goes.
  for id in $OLD_INSTANCES; do
    [[ $id =~ ^i-[0-9a-f]+$ ]] || die "not an instance ID: $id"
    [ "$id" != "$new_id" ] || die "$id is $NEW, the new host"
    [ "$id" != "$eip_instance" ] || die "$id holds the Elastic IP"
    check_world "$id"
    state=$(aws_cli ec2 describe-instances --instance-ids "$id" --query 'Reservations[0].Instances[0].State.Name' --output text)
    [ "$state" != terminated ] || { echo "$id is already terminated"; continue; }
    protection=$(aws_cli ec2 describe-instance-attribute --instance-id "$id" --attribute disableApiTermination --query 'DisableApiTermination.Value' --output text)
    case "$protection" in
      False | false) ;;
      *) die "$id has termination protection, and lifting it is your decision. When you are sure: aws ec2 modify-instance-attribute --instance-id $id --no-disable-api-termination, then run finish again" ;;
    esac
  done

  confirm "Terminate$OLD_INSTANCES?"
  for id in $OLD_INSTANCES; do
    act aws_cli ec2 terminate-instances --instance-ids "$id"
  done
  # shellcheck disable=SC2086
  [ -n "$DRY_RUN" ] || aws_cli ec2 wait instance-terminated --instance-ids $OLD_INSTANCES
  say "Done. $OLD_VOLUME is kept: delete it by hand once you are sure (aws ec2 delete-volume --volume-id $OLD_VOLUME)"
}

# ---- restore -------------------------------------------------------------

# Disaster recovery (#2261). The host is gone, and Redis and the units with it,
# so nothing is read from an old host: the operator supplies the env files, the
# credentials and the commit (see the options at the top). The lost data volume
# is only ever named, to find its snapshots: it is never detached, attached or
# changed, so what is newer than the snapshot can still be recovered from it.
# Run it again after any failure; each step looks at the new host and AWS to see
# what is done. Every step prints how long it took: a volume made from a
# snapshot loads from S3 as it is read, and the rehearsal records how slow that is.

STEP_NAME=""; STEP_T0=0
step() { # step <name>: print how long the last step took, then start this one
  local now
  now=$(date +%s)
  [ -z "$STEP_NAME" ] || echo "timing: $STEP_NAME took $((now - STEP_T0))s"
  STEP_NAME=${1:-}; STEP_T0=$now
  [ -z "$STEP_NAME" ] || say "$STEP_NAME"
}

SNAP=""; SNAP_START=""; SNAP_VOLUME=""; NEW_VOL=""
EIP_ON=""; EIP_ADDRESS=""; PREWARM_STATE=""

restore_inputs() {
  [ -n "$TYPE" ] || die "restore needs --type"
  [ -n "$CYCLE" ] && [[ $CYCLE =~ ^[A-Za-z0-9._-]+$ ]] ||
    die "restore needs --cycle NAME (letters, digits, dots, dashes, underscores): the tag that finds the new host and its volume when you run it again"
  [ -n "$OLD_VOLUME$SNAPSHOT" ] || die "restore needs --old-volume vol-... (the lost data volume) or --snapshot snap-..."
  [ -z "$OLD_VOLUME" ] || [[ $OLD_VOLUME =~ ^vol-[0-9a-f]+$ ]] || die "--old-volume takes a volume ID, vol-..."
  [ -z "$SNAPSHOT" ] || [[ $SNAPSHOT =~ ^snap-[0-9a-f]+$ ]] || die "--snapshot takes a snapshot ID, snap-..."
  [ -n "$EIP" ] || die "restore needs --eip: the Elastic IP the site is served from"
  [[ $COMMIT =~ ^[0-9a-f]{40}$ ]] || die "restore needs --commit, the 40-digit commit of the image to run"
  [[ $REDIS_BACKUP =~ ^[A-Za-z0-9._/-]+$ ]] || die "--redis-backup takes a backup name, as restore.sh lists them"
  [ -n "${BLOT_HOST_SSH_KEY:-}" ] || [ -n "$DRY_RUN" ] || die "set BLOT_HOST_SSH_KEY: the private key for the new host"
  [ -f "$SECRETS_FILE" ] || need "--secrets-env FILE: secrets.env as it was on the lost host (it is not in the repo)"
  [ -f "$PROXY_FILE" ] || need "--proxy-env FILE: proxy.env as it was on the lost host (it is not in the repo)"
  # Only a drill that restores Redis from the offsite copy goes without credentials on the host.
  if [ -n "$AWS_CREDS" ] || [ "$MODE" = production ] || [ -z "$OFFSITE_BUCKET" ]; then
    { [ -f "$AWS_CREDS" ] && grep -q '^\[default\]' "$AWS_CREDS"; } ||
      need "--aws-credentials FILE: a credentials file with a [default] profile that can read the Redis backups and write new ones"
  fi
  if [ -n "$BANS_FILE" ]; then
    [ -f "$BANS_FILE" ] || die "no such file: $BANS_FILE"
    git -C "$(dirname "$BANS_FILE")" check-ignore -q "$(basename "$BANS_FILE")" || die "$BANS_FILE is not ignored by git: the list of banned ranges stays out of the repo"
  fi
}

# restore_snapshot: the newest completed snapshot of the lost volume, or the one
# named. Sets SNAP, SNAP_START (when it started: anything written after that is
# not in it) and SNAP_VOLUME (the volume it was taken from).
restore_snapshot() {
  local row state
  if [ -n "$SNAPSHOT" ]; then
    row=$(aws_cli ec2 describe-snapshots --snapshot-ids "$SNAPSHOT" --query 'Snapshots[0].[SnapshotId,StartTime,VolumeId,State]' --output text)
  else
    row=$(aws_cli ec2 describe-snapshots --owner-ids self \
      --filters "Name=volume-id,Values=$OLD_VOLUME" "Name=status,Values=completed" \
      --query 'sort_by(Snapshots,&StartTime)[-1].[SnapshotId,StartTime,VolumeId,State]' --output text)
  fi
  read -r SNAP SNAP_START SNAP_VOLUME state <<< "$row"
  [[ ${SNAP:-} =~ ^snap-[0-9a-f]+$ ]] || die "no completed snapshot of ${OLD_VOLUME:-$SNAPSHOT}"
  [ "$state" = completed ] || die "$SNAP is $state, not completed"
  [ -z "$OLD_VOLUME" ] || [ "$SNAP_VOLUME" = "$OLD_VOLUME" ] || die "$SNAP is a snapshot of $SNAP_VOLUME, not of $OLD_VOLUME"
  echo "Snapshot $SNAP of $SNAP_VOLUME, started $SNAP_START. Anything written after that is only on $SNAP_VOLUME."
}

# restore_eip: where the Elastic IP is now, and that it is in the world we said
# we are in. Sets EIP_ON (empty when nothing has it) and EIP_ADDRESS.
restore_eip() {
  local tag
  read -r EIP_ON EIP_ADDRESS <<< "$(aws_cli ec2 describe-addresses --allocation-ids "$EIP" --query 'Addresses[0].[InstanceId,PublicIp]' --output text)"
  [ -n "${EIP_ADDRESS:-}" ] || die "cannot read $EIP"
  [ "$EIP_ON" != None ] || EIP_ON=""
  if [ -z "$EIP_ON" ] || [ "$EIP_ON" = "$NEW_ID" ]; then return 0; fi
  tag=$(aws_cli ec2 describe-instances --instance-ids "$EIP_ON" \
    --query 'Reservations[0].Instances[0].Tags[?Key==`BlotDrill`]|[0].Value' --output text 2> /dev/null || echo gone)
  # What keeps a drill off the real address, and a production restore off a drill's.
  if [ "$MODE" = drill ] && [ "$tag" != true ]; then
    die "--drill, but $EIP is on $EIP_ON, which is not tagged BlotDrill=true"
  elif [ "$MODE" = production ] && [ "$tag" = true ]; then
    die "--production, but $EIP is on $EIP_ON, which is tagged BlotDrill=true"
  fi
}

restore_credentials() {
  if [ -z "$AWS_CREDS" ]; then echo "No credentials given: no backups from this host"; return 0; fi
  if [ -n "$DRY_RUN" ]; then echo "would install $AWS_CREDS as ~/.aws/credentials on $NEW"; return 0; fi
  pipe_to "$NEW" 'umask 077; mkdir -p "$HOME/.aws" && cat > "$HOME/.aws/credentials"' < "$AWS_CREDS" ||
    die "could not copy the credentials to $NEW"
  on "$NEW" "printf '[default]\nregion = %s\n' $AWS_REGION > \"\$HOME/.aws/config\""
  on "$NEW" "aws sts get-caller-identity > /dev/null" || die "the credentials do not work on $NEW"
  echo "Credentials installed"
}

restore_redis() {
  local info keys=0 flags=""
  info=$(redis_info "$NEW")
  [ "$(info_field "$info" role)" = master ] || die "$NEW's Redis is not a master: restore needs a fresh one"
  keys=$(on "$NEW" "redis6-cli DBSIZE" | tr -d '\r')
  # A fresh Redis is not empty: its samplers (cron) have written a few keys.
  if [ "$keys" -gt "$FRESH_REDIS_KEYS" ]; then echo "$NEW's Redis already holds $keys keys: not restoring over it"; return 0; fi
  [ -z "$YES" ] || flags="--yes"
  [ -z "$OFFSITE_BUCKET" ] || flags="$flags --offsite $OFFSITE_PROFILE $OFFSITE_BUCKET"
  # shellcheck disable=SC2086
  act "$ROOT/config/redis/restore.sh" $flags "$NEW" "$REDIS_BACKUP"
}

# restore_volume: the volume from the snapshot, in the new host's zone, attached
# to it. Found again by its BlotRestoreCycle tag. It does not get the name the
# snapshot policy targets until the Elastic IP has moved, so that a restore that
# is abandoned leaves nothing for the policy to keep snapshotting.
restore_volume() {
  local found made_from az vtype iops throughput opts tags attached used letter dev
  found=$(aws_cli ec2 describe-volumes --filters "Name=tag:BlotRestoreCycle,Values=$CYCLE" "Name=status,Values=creating,available,in-use" \
    --query 'Volumes[].[VolumeId,SnapshotId]' --output text)
  [ "$(printf '%s\n' "$found" | grep -c .)" -le 1 ] || die "several volumes are tagged BlotRestoreCycle=$CYCLE; delete the ones that are not wanted: $found"
  if [ -n "$found" ]; then
    read -r NEW_VOL made_from <<< "$found"
    [ "$made_from" = "$SNAP" ] || die "$NEW_VOL was made from $made_from, not $SNAP: delete it to use the newer snapshot, or pass --snapshot $made_from"
    echo "Using $NEW_VOL, made for this cycle from $SNAP"
  else
    az=$(aws_cli ec2 describe-instances --instance-ids "$NEW_ID" --query 'Reservations[0].Instances[0].Placement.AvailabilityZone' --output text)
    # The lost volume's type and speed, if it can still be read; else gp3 at its defaults.
    read -r vtype iops throughput <<< "$(aws_cli ec2 describe-volumes --volume-ids "$SNAP_VOLUME" --query 'Volumes[0].[VolumeType,Iops,Throughput]' --output text 2> /dev/null || true)"
    if [ -z "${vtype:-}" ]; then
      vtype=gp3; iops=None; throughput=None
      echo "NOTE: $SNAP_VOLUME cannot be read, so the volume is gp3 at the default speed. Raise it with modify-volume if reads are slow"
    fi
    opts="--snapshot-id $SNAP --availability-zone $az --volume-type $vtype"
    # gp2 reports a baseline Iops (3 per GB) that create-volume rejects; only these types take one.
    case "$vtype" in gp3 | io1 | io2) [ "${iops:-None}" = None ] || opts="$opts --iops $iops" ;; esac
    [ "$vtype" != gp3 ] || [ "${throughput:-None}" = None ] || opts="$opts --throughput $throughput"
    tags='{"Key":"Name","Value":"Blot data (restored for '$CYCLE')"},{"Key":"BlotRestoreCycle","Value":"'$CYCLE'"},{"Key":"BlotRestoredFrom","Value":"'$SNAP_VOLUME'"}'
    [ "$MODE" != drill ] || tags='{"Key":"Name","Value":"drill-data-volume"},{"Key":"BlotRestoreCycle","Value":"'$CYCLE'"},{"Key":"BlotDrill","Value":"true"}'
    if [ -n "$DRY_RUN" ]; then
      echo "would run: aws ec2 create-volume $opts, tagged BlotRestoreCycle=$CYCLE, then attach it to $NEW_ID"
      NEW_VOL=vol-00000000000000000
      return 0
    fi
    # shellcheck disable=SC2086
    NEW_VOL=$(aws_cli ec2 create-volume $opts --tag-specifications '[{"ResourceType":"volume","Tags":['"$tags"']}]' --query VolumeId --output text)
    echo "Created $NEW_VOL"
  fi
  attached=$(aws_cli ec2 describe-volumes --volume-ids "$NEW_VOL" --query 'Volumes[0].Attachments[0].InstanceId' --output text)
  if [ "$attached" = "$NEW_ID" ]; then echo "$NEW_VOL is attached to $NEW_ID"; return 0; fi
  [ -z "$attached" ] || [ "$attached" = None ] || die "$NEW_VOL is attached to $attached, not to $NEW_ID"
  aws_cli ec2 wait volume-available --volume-ids "$NEW_VOL"
  used=$(aws_cli ec2 describe-instances --instance-ids "$NEW_ID" --query 'Reservations[0].Instances[0].BlockDeviceMappings[].DeviceName' --output text | tr '\t' ' ')
  dev=""
  for letter in f g h i j k l m n o p; do
    case " $used " in *" /dev/sd$letter "* | *" /dev/xvd$letter "*) ;; *) dev=/dev/sd$letter; break ;; esac
  done
  [ -n "$dev" ] || die "no free device name between /dev/sdf and /dev/sdp on $NEW_ID (in use: $used)"
  aws_cli ec2 attach-volume --volume-id "$NEW_VOL" --instance-id "$NEW_ID" --device "$dev" > /dev/null
  aws_cli ec2 wait volume-in-use --volume-ids "$NEW_VOL"
  echo "Attached as $dev"
}

# host.sh runs on the new host, as in resize.sh move.
host_script() { on "$NEW" "sudo bash /tmp/blot-data-volume/host.sh $*"; }

# Three cold reads straight from the device, at random places, before the
# pre-warm touches it: what a request costs while its blocks load from S3.
read_probe() {
  local i
  for i in 1 2 3; do
    on "$NEW" "dev=\$(readlink -f /dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${NEW_VOL/-/}); mb=\$((\$(sudo blockdev --getsize64 \$dev) / 1048576 - 256)); sudo dd if=\$dev of=/dev/null bs=1M count=256 skip=\$(( (RANDOM * 32768 + RANDOM) % mb )) iflag=direct 2>&1 | tail -n 1" ||
      echo "(the read probe failed)"
  done
}

# prewarm_line: one line on the pre-warm; sets PREWARM_STATE (running, ok, ...).
prewarm_line() {
  local out
  PREWARM_STATE=unknown
  out=$(host_script prewarm "$NEW_VOL") || { echo "pre-warm: cannot ask $NEW"; return 0; }
  PREWARM_STATE=$(echo "$out" | sed -n 's/^prewarm=//p')
  echo "pre-warm: $PREWARM_STATE, $(echo "$out" | sed -n 's/^prewarm_percent=//p')% read, $(echo "$out" | sed -n 's/^prewarm_duration_s=//p')s so far"
}

# copy_env_files: the env files from the operator's machine, with the socket
# settings written into the new host's copy (the script app uses). Sets ENV_CHANGED.
copy_env_files() {
  local tmp out
  tmp=$(umask 077; mktemp -d)
  cp "$SECRETS_FILE" "$tmp/secrets.env"; cp "$PROXY_FILE" "$tmp/proxy.env"
  # tar -p would carry the operator's modes to the host.
  chmod 600 "$tmp/secrets.env" "$tmp/proxy.env"
  out=$(COPYFILE_DISABLE=1 tar -C "$tmp" -cf - secrets.env proxy.env |
    pipe_to "$NEW" "sudo bash -c $(printf %q "$ENV_SCRIPT") cycle $SOCKET") || { rm -rf "$tmp"; die "could not install the env files on $NEW"; }
  rm -rf "$tmp"
  case "$out" in *changed*) ENV_CHANGED=1 ;; esac
  # An earlier run may have written them and stopped before the units were verified.
  ! on "$NEW" "test -e /etc/blot/cycle-env-pending" || ENV_CHANGED=1
  echo "Env files on $NEW: $([ -n "$ENV_CHANGED" ] && echo installed || echo already current), on the Redis socket"
}

# The production address moves only for a person who says which host loses it: a
# host may be unreachable rather than gone.
confirm_eip_move() {
  local state="" status="" reply holder=${EIP_ON:-none}
  if [ -n "$EIP_ON" ]; then
    state=$(aws_cli ec2 describe-instances --instance-ids "$EIP_ON" --query 'Reservations[0].Instances[0].State.Name' --output text 2> /dev/null || echo gone)
    status=$(aws_cli ec2 describe-instance-status --instance-ids "$EIP_ON" --include-all-instances --query 'InstanceStatuses[0].InstanceStatus.Status' --output text 2> /dev/null || echo unknown)
  fi
  cat << EOF

$EIP ($EIP_ADDRESS) is on: $holder${state:+ (state $state, status checks $status)}
Moving it makes $NEW_ID the site, with the data of the snapshot of $SNAP_START and the Redis backup.
If that host is only unreachable and not gone, stop it first (aws ec2 stop-instances): it holds
newer data, and if it came back beside this one there would be two Redis masters. This script
neither stops nor touches it.
EOF
  [ -z "$DRY_RUN" ] || return 0
  if [ "$MODE" = drill ]; then confirm "Move $EIP to $NEW_ID?"; return 0; fi
  # Not --yes: only a person at the terminal moves a production address.
  [ -t 0 ] || die "moving the production Elastic IP needs a person at the terminal: run this again from one"
  read -r -p "Type the ID of the host losing the address ($holder): " reply || die "no answer"
  [ "$reply" = "$holder" ] || die "aborted"
}

# restore_follow_eip: a resumed restore whose Elastic IP is already on the host it
# launched. That host's launch-time address is released, so <new> reaches nothing
# until ssh follows the Elastic IP, before even its instance ID can be read.
restore_follow_eip() {
  local holder address tag
  read -r holder address <<< "$(aws_cli ec2 describe-addresses --allocation-ids "$EIP" --query 'Addresses[0].[InstanceId,PublicIp]' --output text)"
  [ -n "${holder:-}" ] && [ "$holder" != None ] || return 0
  tag=$(aws_cli ec2 describe-instances --instance-ids "$holder" \
    --query 'Reservations[0].Instances[0].Tags[?Key==`BlotCycle`]|[0].Value' --output text 2> /dev/null || true)
  [ "$tag" != "$CYCLE" ] || follow_eip "$address"
}

phase_restore() {
  local keys problem address host code tagged t0
  restore_inputs
  aws_cli sts get-caller-identity > /dev/null || die "the AWS session has expired"
  t0=$(date +%s)

  step "Snapshot and Elastic IP"
  restore_snapshot
  NEW_ID=""
  if [ -n "$NEW" ]; then
    restore_follow_eip
    NEW_ID=$(instance_id "$NEW")
    [ -n "$NEW_ID" ] || die "cannot reach $NEW"
    check_world "$NEW_ID"
    tagged=$(aws_cli ec2 describe-instances --instance-ids "$NEW_ID" --query 'Reservations[0].Instances[0].Tags[?Key==`BlotCycle`]|[0].Value' --output text)
    [ "$tagged" = "$CYCLE" ] || die "$NEW ($NEW_ID) is not tagged BlotCycle=$CYCLE: restore only sets up the host it launched"
  fi
  restore_eip

  if [ -z "$NEW" ]; then
    step "Launch"
    phase_launch
    step ""
    return 0
  fi

  step "Credentials for backups"
  restore_credentials

  step "Redis from the backup"
  restore_redis
  if [ -z "$DRY_RUN" ]; then
    keys=$(on "$NEW" "redis6-cli DBSIZE" | tr -d '\r')
    [ "$keys" -gt "$FRESH_REDIS_KEYS" ] || die "$NEW's Redis holds only $keys keys after the restore: it looks fresh, not restored"
    echo "Redis on $NEW holds $keys keys"
  fi

  step "Data volume from the snapshot"
  restore_volume

  step "Cold reads, then adopting the volume and starting the pre-warm"
  if [ -z "$DRY_RUN" ]; then
    COPYFILE_DISABLE=1 tar -C "$HERE/data-volume" -cf - host.sh |
      pipe_to "$NEW" 'rm -rf /tmp/blot-data-volume && mkdir /tmp/blot-data-volume && tar -xf - -C /tmp/blot-data-volume' ||
      die "cannot copy host.sh to $NEW"
    read_probe
  fi
  act host_script adopt "$NEW_VOL" "$SNAP_VOLUME"
  act host_script prewarm "$NEW_VOL"

  step "Mounting the volume (deploy.sh)"
  act deploy_host "$(ssh_config "$NEW" hostname)" "$NEW_VOL"
  [ -n "$DRY_RUN" ] || [ "$(on "$NEW" "sudo cat /var/www/blot/data/.blot-data-volume" | tr -d '\r')" = "$NEW_VOL" ] ||
    die "$NEW's data directory does not carry the marker of $NEW_VOL"

  step "Env files and the wildcard certificate"
  act copy_env_files
  act "$HERE/wildcard-cert.sh" "$NEW"

  step "The units, commit $COMMIT"
  act on "$NEW" "sudo systemctl start docker"
  # Redis is a master here, so this is an ordinary deploy, writes included.
  act env BLOT_DEPLOY_TARGET="$NEW" PROXY_DEPLOY_FORCE="${ENV_CHANGED:+1}" "$ROOT/scripts/deploy/units.sh" "$COMMIT"
  if [ -n "$DRY_RUN" ]; then
    echo "would check the units and curl the site through $NEW's private IP"
  else
    problem=$(units_ok "$NEW") || die "$problem"
    address=$(primary_ip "$NEW")
    host=$(env_value "$NEW" BLOT_HOST)
    [ -n "$host" ] || die "no BLOT_HOST in $NEW's proxy.env"
    for host in $host $VERIFY_HOSTS; do
      code=$(probe "$address" "$host" /)
      [ "$code" = 200 ] || die "https://$host/ through $address answered $code"
      echo "$host answers 200 through $address"
    done
  fi
  # Only now: until the units are verified, a rerun must still redeploy them.
  act on "$NEW" "sudo rm -f /etc/blot/cycle-env-pending"

  step "The volume's pre-warm"
  if [ -z "$DRY_RUN" ]; then
    prewarm_line
    if [ -n "$WAIT_PREWARM" ]; then
      while [ "$PREWARM_STATE" != ok ]; do
        [ "$PREWARM_STATE" = running ] || die "the pre-warm is '$PREWARM_STATE'"
        sleep 60
        prewarm_line
      done
    elif [ "$PREWARM_STATE" != ok ]; then
      echo "Still loading, so reads are slower until it finishes (--wait-prewarm waits for it before the address moves)"
    fi
  fi

  step "Moving the Elastic IP"
  if [ "$EIP_ON" = "$NEW_ID" ]; then
    echo "$EIP is already on $NEW_ID"
  else
    confirm_eip_move
    act aws_cli ec2 associate-address --allocation-id "$EIP" --instance-id "$NEW_ID" --allow-reassociation
    if [ -z "$DRY_RUN" ]; then
      [ "$(aws_cli ec2 describe-addresses --allocation-ids "$EIP" --query 'Addresses[0].InstanceId' --output text)" = "$NEW_ID" ] ||
        die "$EIP is not on $NEW_ID"
      follow_eip "$EIP_ADDRESS"
      host=$(env_value "$NEW" BLOT_HOST)
      wait_public_health "$EIP_ADDRESS" "$host"
    fi
  fi

  step "Backups, snapshots and permabans"
  # From here this host is the one that backs up, and its volume the one that is snapshotted.
  act on "$NEW" "sudo mkdir -p /etc/blot-redis && sudo touch /etc/blot-redis/active"
  [ "$MODE" != production ] ||
    act aws_cli ec2 create-tags --resources "$NEW_VOL" --tags "Key=Name,Value=Blot /var/www/blot/data" # must match DATA_NAME in data-volume/resize.sh
  [ -z "$BANS_FILE" ] || act "$HERE/bans.sh" import "$NEW" "$BANS_FILE"
  step ""

  say "Restored in $(($(date +%s) - t0))s: $NEW serves $EIP_ADDRESS"
  cat << EOF
Before the reconcile, change HostName for $NEW in ~/.ssh/config to $EIP_ADDRESS: its launch address is released.
The data is as of $SNAP_START. Now reconcile (README.md, "Recovery"): it prints a plan first, then
resyncs the sync-client blogs and lists the git blogs whose owners push again:
  ssh $NEW sudo docker exec --user 1000:1000 -e HOME=/home/node blot-blue node scripts/host-cycle/reconcile.js --since $SNAP_START
$SNAP_VOLUME was not touched. Anything newer than the snapshot is on it, so keep it until the
reconcile is done. It still has the name the snapshot policy targets: retag it once the new
volume has its first snapshot.
Not restored: the offsite backup settings (/etc/blot-redis/offsite-bucket and its profile). Set them up by hand.
EOF
}

# ---- status --------------------------------------------------------------

phase_status() {
  local info old_info u
  OLD_ID=$(instance_id "$OLD_NOW"); NEW_ID=$(instance_id "$NEW")
  echo "old     $OLD_NOW: ${OLD_ID:-not reachable}"
  echo "new     $NEW: ${NEW_ID:-not reachable}"
  info=$(redis_info "$NEW"); old_info=$(redis_info "$OLD_REDIS")
  echo "launch  redis6 $(on "$NEW" "systemctl is-active redis6" 2> /dev/null || echo down), instance store $(on "$NEW" "mountpoint -q /var/instance-ssd && echo mounted || echo missing" 2> /dev/null)"
  echo "redis   $NEW: $(info_field "$info" role) (link $(info_field "$info" master_link_status), of $(info_field "$info" master_host)); $OLD_REDIS: $(info_field "$old_info" role)"
  echo "data    $(rs move status 2> /dev/null | grep -E '^(Move|Target|No move)' | tr -s ' ' | tr '\n' ' ')"
  for u in $UNIT_NAMES; do
    echo "app     $u on $NEW: $(docker_field "$NEW" "$u" '{{.State.Status}} {{.Config.Image}}'), on $OLD_NOW: $(docker_field "$OLD_NOW" "$u" '{{.State.Status}}')"
  done
  echo "deploys paused: $NEW $(on "$NEW" "test -e $PAUSE_FILE && echo yes || echo no" 2> /dev/null), $OLD_NOW $(on "$OLD_NOW" "test -e $PAUSE_FILE && echo yes || echo no" 2> /dev/null)"
  echo "freeze  $(on "$NEW" "sudo docker exec blot-blue node scripts/read-only.js status" 2> /dev/null | grep '^{' || echo "unknown")"
  if [ -n "$EIP" ]; then
    echo "eip     $EIP is on $(aws_cli ec2 describe-addresses --allocation-ids "$EIP" --query 'Addresses[0].InstanceId' --output text)"
  fi
}

case "$PHASE" in
  status) phase_status ;;
  # finish names its hosts by ID: the old ones need not answer any more.
  finish) refuse_window; phase_finish ;;
  # Not held back by the 01:00 and 05:00 hours: the site is down, and waiting costs more.
  restore) phase_restore ;;
  *) refuse_window; guard; "phase_$PHASE" ;;
esac
