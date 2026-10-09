#!/bin/bash
# Usage: resize.sh [options] status
#        resize.sh [options] grow <size-GiB>
#        resize.sh [options] shrink <size-GiB> [--type gp3] [--iops N] [--throughput MiBps]
#        resize.sh [options] finish
# Resizes the EBS volume mounted at /var/www/blot/data on the app host.
#
#   status   what the host and the volume look like, and any resize in progress
#   grow     online: modify-volume, then xfs_growfs. No freeze, nothing stops.
#   shrink   EBS volumes cannot shrink, so: a new smaller volume is attached,
#            filled with rsync while the app runs, then the app is made
#            read-only for a short window, the last differences are copied and
#            the new volume is mounted over the data directory. Resumable:
#            re-run the same command after Ctrl-C or an error.
#   finish   after a shrink, once the old volume is no longer mounted anywhere
#            (containers recreated, host rebooted): detach it. Never deletes.
#
# Read config/host/data-volume/README.md first, and rehearse with drill.sh.
# Needs the read-only freeze (scripts/read-only.js) and the rslave data bind
# deployed, and /etc/blot/data-volume on the host (config/host/deploy.sh).
#
# Options:
#   --host SSH_HOST          the app host (default blot)
#   --profile NAME           AWS CLI profile (default blot)   --region NAME (default us-west-2)
#   --container NAME         the container read-only.js runs in (default blot-container-blue)
#   --lock-wait SECONDS      how long to wait for held folder locks to drain (default 120)
#   --grace SECONDS          how long to wait after the freeze starts before
#                            looking at the folder locks (default 15)
#   --max-final-seconds N    stop the live passes once one takes this long or
#                            less (default 300); after 5 passes you are asked
#   --freeze-ttl SECONDS     how long the read-only freeze lasts if this script
#                            dies (default 900); the frozen copy must fit in it
#   --any-time               allow the freeze within 10 minutes of 01:00 and 05:00 UTC
#   --yes                    do not ask for confirmation
#   --dry-run                run every read-only check and print every step;
#                            change nothing (only /tmp/blot-data-volume/host.sh
#                            is copied to the host, which the checks need)
# shrink only: --type gp3|gp2 (default gp3), --iops N, --throughput MiBps (gp3).
set -euo pipefail
. "$(dirname "$0")/lib.sh"

HOST=blot
AWS_PROFILE_NAME=blot
AWS_REGION=${AWS_REGION:-us-west-2}
CONTAINER=blot-container-blue
LOCK_WAIT=120
GRACE=15
# A live pass is one rsync walking the whole tree; the frozen pass walks it in
# parallel shards, so it takes well under the last live pass. Five minutes of
# live pass is a frozen pass of about a minute or less.
MAX_FINAL=300
FREEZE_TTL=900
ANY_TIME=""; YES=""; DRY_RUN=""
VTYPE=gp3; IOPS=""; THROUGHPUT=""
CMD=""; SIZE=""

REMOTE=/tmp/blot-data-volume/host.sh
DATA_NAME="Blot /var/www/blot/data" # the Name tag the DLM snapshot policy targets
PASS_LIMIT=5                        # live passes before we ask
STALE_PASS_SECONDS=1800             # a finished pass older than this does not count on a resume
PLACEHOLDER_VOLUME=vol-00000000000000000

while [ $# -gt 0 ]; do
  case "$1" in
    --host | --profile | --region | --container | --lock-wait | --grace | --max-final-seconds | --freeze-ttl | --type | --iops | --throughput)
      [ $# -ge 2 ] || die "$1 needs a value" ;;
  esac
  case "$1" in
    --host) HOST=$2; shift 2 ;;
    --profile) AWS_PROFILE_NAME=$2; shift 2 ;;
    --region) AWS_REGION=$2; shift 2 ;;
    --container) CONTAINER=$2; shift 2 ;;
    --lock-wait) LOCK_WAIT=$2; shift 2 ;;
    --grace) GRACE=$2; shift 2 ;;
    --max-final-seconds) MAX_FINAL=$2; shift 2 ;;
    --freeze-ttl) FREEZE_TTL=$2; shift 2 ;;
    --type) VTYPE=$2; shift 2 ;;
    --iops) IOPS=$2; shift 2 ;;
    --throughput) THROUGHPUT=$2; shift 2 ;;
    --any-time) ANY_TIME=1; shift ;;
    --yes) YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -*) die "unknown option $1" ;;
    *)
      if [ -z "$CMD" ]; then CMD=$1
      elif [ -z "$SIZE" ]; then SIZE=$1
      else die "unexpected argument $1"; fi
      shift ;;
  esac
done
case "$CMD" in status | grow | shrink | finish) ;; *) die "usage: resize.sh [options] status|grow <GiB>|shrink <GiB>|finish" ;; esac
case "$LOCK_WAIT$GRACE$MAX_FINAL$FREEZE_TTL$IOPS$THROUGHPUT" in *[!0-9]*) die "--lock-wait, --grace, --max-final-seconds, --freeze-ttl, --iops and --throughput take numbers" ;; esac
case "$VTYPE" in gp2 | gp3) ;; *) die "--type must be gp3 or gp2" ;; esac
# The final copy gets FREEZE_TTL minus 90 seconds (for the snapshot, the swap
# and lifting the freeze) as its time limit, so the TTL has to leave a real one.
[ "$FREEZE_TTL" -ge 300 ] || die "--freeze-ttl must be at least 300 seconds (the final copy gets the TTL minus 90 s as its time limit)"
if [ "$CMD" = grow ] || [ "$CMD" = shrink ]; then
  case "$SIZE" in "" | *[!0-9]*) die "$CMD needs a size in GiB, e.g. resize.sh $CMD 600" ;; esac
elif [ -n "$SIZE" ]; then
  die "unexpected argument $SIZE"
fi
[ "$VTYPE" = gp3 ] || [ -z "$IOPS$THROUGHPUT" ] || die "--iops and --throughput are for gp3"

# One ssh connection for the whole run: the freeze is timed and each new
# handshake costs hundreds of milliseconds. Keepalives because the live passes
# can keep us polling for hours.
CTL=/tmp/blot-resize.$$
mkdir -m 700 "$CTL"
SSH_OPTS="${SSH_OPTS:-} -o ControlMaster=auto -o ControlPath=$CTL/%C -o ControlPersist=600 -o ServerAliveInterval=30 -o ServerAliveCountMax=6"

# FREEZE_STAGE says what undo_freeze has to put back: none | app (writes
# refused) | disk (and the old volume remounted read-only) | copying (and the
# frozen copy may still be running) | swapping (and a swap may have been
# started; host.sh swap undoes itself) | swapped (only the app freeze is left)
# | done.
FREEZE_STAGE=none
PAUSED=""
cleanup() {
  undo_freeze
  for h in $HOST; do ssh -o ControlPath="$CTL/%C" -O exit "$h" > /dev/null 2>&1 || true; done
  rm -rf "$CTL"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# Talking to the host
##########################################################

# host <subcommand> [args]: a host.sh subcommand that only reads.
host() { ssh_run "$HOST" "sudo bash $REMOTE $*" < /dev/null; }
# host_do <subcommand> [args]: one that changes something. In a dry run the
# host prints what it would do.
host_do() { ssh_run "$HOST" "sudo bash $REMOTE ${DRY_RUN:+--dry-run} $*" < /dev/null; }
# mutate <aws args>: an AWS call that changes something. In a dry run it is
# only printed (on stderr, so a $(...) around it stays empty).
aws_mut() {
  if [ -n "$DRY_RUN" ]; then echo "would run: aws --profile $AWS_PROFILE_NAME --region $AWS_REGION $*" >&2; return 0; fi
  aws_cli "$@"
}
# ro <args>: scripts/read-only.js in the app container; prints its JSON line.
ro() { ssh_run "$HOST" "sudo docker exec $CONTAINER node scripts/read-only.js $*" < /dev/null | grep '^{'; }

confirm() {
  if [ -n "$DRY_RUN" ]; then echo "(would ask: $1)"; return 0; fi
  [ -z "$YES" ] || return 0
  local reply
  read -r -p "$1 Type yes: " reply || die "no answer (use --yes when not running interactively)"
  [ "$reply" = yes ] || die "aborted"
}

# Looking at the host and the volume
##########################################################

gather_facts() {
  FACTS=$(host facts) || die "cannot run host.sh on $HOST (ssh, or passwordless sudo)"
  INSTANCE=$(field "$FACTS" instance_id); AZ=$(field "$FACTS" az)
  CUR_VOL=$(field "$FACTS" volume_id)
  PROPAGATION=$(field "$FACTS" propagation); FSTYPE=$(field "$FACTS" fstype)
  SIZE_B=$(field "$FACTS" size_bytes); USED_B=$(field "$FACTS" used_bytes)
  DRILL=$(field "$FACTS" drill)
  PHASE=$(field "$FACTS" resize_phase); R_OLD=$(field "$FACTS" resize_old); R_NEW=$(field "$FACTS" resize_new)
}

# describe_volume <id>: sets V_SIZE V_TYPE V_IOPS V_TPUT V_AZ V_ENC V_KMS V_STATE V_INST V_NAME
describe_volume() {
  local row
  row=$(aws_cli ec2 describe-volumes --volume-ids "$1" \
    --query 'Volumes[0].[Size,VolumeType,Iops,Throughput,AvailabilityZone,Encrypted,KmsKeyId,State,Attachments[0].InstanceId]' --output text) ||
    die "cannot describe $1"
  IFS=$'\t' read -r V_SIZE V_TYPE V_IOPS V_TPUT V_AZ V_ENC V_KMS V_STATE V_INST <<< "$row"
  V_NAME=$(aws_cli ec2 describe-volumes --volume-ids "$1" --query 'Volumes[0].Tags[?Key==`Name`].Value | [0]' --output text)
}

preflight() {
  say "Checking $HOST and AWS"
  aws_cli sts get-caller-identity --query Arn --output text > /dev/null 2>&1 ||
    die "the AWS CLI does not work; run: aws sso login --profile $AWS_PROFILE_NAME"
  # The checks below need host.sh on the host; this is the one thing a dry run copies.
  push_host_script "$HOST" || die "cannot copy host.sh to $HOST"
  gather_facts
  [ -n "$INSTANCE" ] && [ -n "$AZ" ] || die "the host did not report its instance ID and zone (IMDS)"
  [ "$(field "$FACTS" mountpoint)" = yes ] || die "/var/www/blot/data is not a mount point on $HOST"
  [ "$FSTYPE" = xfs ] || die "/var/www/blot/data is $FSTYPE, not xfs"
  [[ "$CUR_VOL" =~ ^vol-[0-9a-f]{8,17}$ ]] || die "/etc/blot/data-volume on $HOST does not hold a volume ID ('$CUR_VOL'): see config/host/README.md"
  describe_volume "$CUR_VOL"
  [ "$V_INST" = "$INSTANCE" ] || die "$CUR_VOL is attached to '$V_INST', not to $HOST's instance"
  [ "$V_AZ" = "$AZ" ] || die "$CUR_VOL is in $V_AZ but the host is in $AZ"
  CUR_SIZE=$V_SIZE; CUR_TYPE=$V_TYPE; CUR_IOPS=$V_IOPS; CUR_TPUT=$V_TPUT; CUR_ENC=$V_ENC; CUR_KMS=$V_KMS; CUR_NAME=$V_NAME
  [ "$(field "$FACTS" rsync)" = yes ] || echo "WARNING: rsync is not installed on the host"
  [ "$(field "$FACTS" xfsprogs)" = yes ] || echo "WARNING: xfsprogs is not installed on the host"

  echo "Host:       $HOST ($INSTANCE, $AZ)$([ "$DRILL" != yes ] || echo ", drill host")"
  echo "Volume:     $CUR_VOL, $CUR_SIZE GiB $CUR_TYPE (iops $CUR_IOPS, throughput ${CUR_TPUT}), encrypted $CUR_ENC, Name '$CUR_NAME'"
  echo "Filesystem: xfs, $(gib "$USED_B") of $(gib "$SIZE_B") GiB used ($((USED_B * 100 / SIZE_B))%), $(field "$FACTS" inodes_used) inodes, propagation $PROPAGATION, $(field "$FACTS" options)"
  local line
  for line in $(echo "$FACTS" | grep '^container\.'); do echo "Container:  ${line#container.}"; done
  [ -z "$PHASE" ] || echo "Resize state on the host: phase=$PHASE old=$R_OLD new=$R_NEW"
}

# Status
##########################################################

cmd_status() {
  local l inflight
  for l in $(field "$FACTS" copy_labels); do
    echo
    echo "Copy pass $l:"
    host copy-status "$l" | sed 's/^/  /'
  done
  inflight=$(aws_cli ec2 describe-volumes --filters "Name=tag:BlotDataVolumeResizeFrom,Values=$CUR_VOL" \
    --query 'Volumes[].[VolumeId,Size,State,Tags[?Key==`Name`].Value|[0]]' --output text)
  if [ -n "$inflight" ]; then echo; echo "Volumes copied from $CUR_VOL:"; echo "$inflight" | sed 's/^/  /'; fi
}

# Grow
##########################################################

# An online grow needs no freeze: EBS grows the device under the mounted
# filesystem, and XFS grows while mounted. Nothing stops, nothing is copied.
cmd_grow() {
  case "$PHASE" in prepared | copied) die "a shrink is in progress ($R_NEW); finish or abandon it first" ;; esac
  local out state i fs_only=""
  if [ "$SIZE" -eq "$CUR_SIZE" ] && [ "$SIZE_B" -lt $((SIZE * 1073741824 / 100 * 99)) ]; then
    # EBS already has the new size (an earlier grow stopped before the
    # filesystem step): only the filesystem is left.
    fs_only=1
    say "$CUR_VOL is already $SIZE GiB but the filesystem is only $(gib "$SIZE_B") GiB (an interrupted grow?): growing the filesystem only"
    confirm "Grow the filesystem?"
  else
    [ "$SIZE" -gt "$CUR_SIZE" ] || die "$SIZE GiB is not larger than the current $CUR_SIZE GiB (use shrink to go smaller)"
    say "Grow $CUR_VOL from $CUR_SIZE to $SIZE GiB (same type, IOPS and throughput: $CUR_TYPE)"
    confirm "Grow it? This runs online; AWS allows one change per volume every 6 hours."
  fi
  if [ -n "$fs_only" ]; then
    :
  elif [ -n "$DRY_RUN" ]; then
    aws_mut ec2 modify-volume --volume-id "$CUR_VOL" --size "$SIZE"
  else
    out=$(aws_cli ec2 modify-volume --volume-id "$CUR_VOL" --size "$SIZE" 2>&1) || {
      case "$out" in
        *RateExceeded* | *"maximum modification rate"*)
          die "AWS refuses: a volume can only be modified once every 6 hours, and this one was modified more recently. Try again later. ($out)" ;;
      esac
      die "modify-volume failed: $out"
    }
    for ((i = 0; i < 120; i++)); do
      state=$(aws_cli ec2 describe-volumes-modifications --volume-ids "$CUR_VOL" --query 'VolumesModifications[0].ModificationState' --output text)
      echo "  modification: $state"
      case "$state" in optimizing | completed) break ;; esac
      sleep 5
    done
    case "$state" in optimizing | completed) ;; *) die "the modification is still '$state' after 10 minutes; check the volume in the console, then run 'grow $SIZE' again for the filesystem step" ;; esac
  fi
  say "Growing the filesystem"
  echo "Before: $(gib "$SIZE_B") GiB filesystem, $(gib "$USED_B") GiB used"
  out=$(host_do grow-fs $((SIZE * 1073741824)))
  if [ -z "$DRY_RUN" ]; then
    echo "After:  $(gib "$(field "$out" fs_size_after)") GiB filesystem"
    gather_facts
    echo "Used:   $(gib "$USED_B") of $(gib "$SIZE_B") GiB"
  else
    echo "$out"
  fi
}

# Shrink
##########################################################

# highest_pass: the number N of the newest live pass "pN" on the host, or 0.
highest_pass() {
  local labels l max=0 n
  labels=$(field "$(host facts)" copy_labels)
  for l in $labels; do
    case "$l" in p[0-9]*) n=${l#p}; [ "$n" -le "$max" ] || max=$n ;; esac
  done
  echo "$max"
}

# step 1: the new volume exists and is attached to the instance.
step_create_and_attach() {
  local tags opts used letter dev att i
  say "1. The new volume"
  if [ -z "$NEW_VOL" ]; then
    tags='{"Key":"Name","Value":"Blot data (copy in progress)"},{"Key":"BlotDataVolumeResizeFrom","Value":"'$CUR_VOL'"}'
    [ "$DRILL" != yes ] || tags="$tags"',{"Key":"BlotDrill","Value":"true"}'
    opts="--availability-zone $AZ --size $SIZE --volume-type $VTYPE"
    [ -z "$IOPS" ] || opts="$opts --iops $IOPS"
    [ -z "$THROUGHPUT" ] || opts="$opts --throughput $THROUGHPUT"
    [ "$CUR_ENC" != True ] || opts="$opts --encrypted"
    [ "$CUR_ENC" != True ] || [ "$CUR_KMS" = None ] || opts="$opts --kms-key-id $CUR_KMS"
    confirm "Create a $SIZE GiB $VTYPE volume in $AZ (encrypted: $CUR_ENC) and attach it to $INSTANCE?"
    # shellcheck disable=SC2086
    NEW_VOL=$(aws_mut ec2 create-volume $opts --tag-specifications '[{"ResourceType":"volume","Tags":['"$tags"']}]' --query VolumeId --output text)
    if [ -n "$DRY_RUN" ]; then NEW_VOL=$PLACEHOLDER_VOLUME; else echo "Created $NEW_VOL"; fi
  else
    echo "Using $NEW_VOL (already created)"
  fi
  if [ -n "$DRY_RUN" ] && [ "$NEW_VOL" = "$PLACEHOLDER_VOLUME" ]; then
    aws_mut ec2 wait volume-available --volume-ids "$NEW_VOL"
    aws_mut ec2 attach-volume --volume-id "$NEW_VOL" --instance-id "$INSTANCE" --device "/dev/sdf (first free of /dev/sdf../dev/sdp)"
    return 0
  fi
  describe_volume "$NEW_VOL"
  if [ -n "$V_INST" ] && [ "$V_INST" != None ]; then
    [ "$V_INST" = "$INSTANCE" ] || die "$NEW_VOL is attached to $V_INST, not to this host's instance"
  else
    aws_cli ec2 wait volume-available --volume-ids "$NEW_VOL"
    # The first free letter in /dev/sdf../dev/sdp; AWS may report an attached
    # /dev/sdf as /dev/xvdf, so both spellings count as used.
    used=$(aws_cli ec2 describe-instances --instance-ids "$INSTANCE" --query 'Reservations[0].Instances[0].BlockDeviceMappings[].DeviceName' --output text | tr '\t' ' ')
    dev=""
    for letter in f g h i j k l m n o p; do
      case " $used " in *" /dev/sd$letter "* | *" /dev/xvd$letter "*) ;; *) dev=/dev/sd$letter; break ;; esac
    done
    [ -n "$dev" ] || die "no free device name between /dev/sdf and /dev/sdp (in use: $used)"
    aws_mut ec2 attach-volume --volume-id "$NEW_VOL" --instance-id "$INSTANCE" --device "$dev" > /dev/null
    echo "Attached as $dev"
  fi
  aws_cli ec2 wait volume-in-use --volume-ids "$NEW_VOL"
  for ((i = 0; i < 60; i++)); do
    att=$(aws_cli ec2 describe-volumes --volume-ids "$NEW_VOL" --query 'Volumes[0].Attachments[0].State' --output text)
    [ "$att" != attached ] || break
    sleep 2
  done
  [ "$att" = attached ] || die "$NEW_VOL is '$att', not attached"
}

# step 2: format and stage it on the host.
step_prepare() {
  local out
  say "2. Preparing $NEW_VOL on the host (mkfs if blank, mount at the staging directory)"
  out=$(host_do prepare "$NEW_VOL") || die "prepare failed"
  echo "$out"
}

# wait_pass <n>: follow pass pN until it ends; REP is its final report.
wait_pass() {
  local label=p$1 fails=0 st dur used
  while :; do
    if REP=$(host copy-status "$label"); then
      fails=0
      st=$(field "$REP" state)
      case "$st" in
        running)
          dur=$(field "$REP" duration_s); used=$(field "$REP" new_used_bytes)
          echo "  pass $1: running $(fmt_duration "${dur:-0}"), $(gib "${used:-0}") GiB on the new volume" ;;
        ok) return 0 ;;
        failed) return 0 ;;
        *) die "pass $1 is gone from the host" ;;
      esac
    else
      fails=$((fails + 1))
      [ "$fails" -lt 10 ] || die "lost contact with $HOST; the copy keeps running there, re-run to attach to it"
    fi
    sleep 30
  done
}

# start_pass <n>: start pass pN (or find it already running) and wait for it.
start_pass() {
  local st
  if [ -n "$DRY_RUN" ]; then
    host_do copy "p$1"
    REP="state=ok
duration_s=0"
    return 0
  fi
  REP=$(host_do copy "p$1") || die "could not start pass $1"
  echo "Pass $1 started as $(field "$REP" unit) (it survives this script; Ctrl-C is fine, re-run to attach)"
  wait_pass "$1"
  st=$(field "$REP" state)
  [ "$st" = ok ] || die "pass $1 failed (exit $(field "$REP" exit_code)); see 'journalctl -u $(field "$REP" unit)' on $HOST. Re-run to retry it."
}

# step 3: live passes until a pass is short enough.
step_passes() {
  local n runs=0 have_ok="" st age dur used
  say "3. Live copy passes (the app keeps running; each pass copies what changed since the last)"
  trap 'echo; echo "Interrupted. The copy keeps running on the host; re-run the same command to attach to it."; exit 130' INT TERM
  n=$(highest_pass)
  if [ "$n" -gt 0 ] && [ -z "$DRY_RUN" ]; then
    REP=$(host copy-status "p$n"); st=$(field "$REP" state)
    case "$st" in
      running)
        echo "Attaching to pass $n"
        wait_pass "$n"
        # A pass that failed is retried below under the same label.
        if [ "$(field "$REP" state)" = ok ]; then runs=1; have_ok=1; else n=$((n - 1)); fi ;;
      ok)
        age=$(field "$REP" age_s)
        # A finished pass from before a long pause no longer says how big the
        # difference is now: start a new one.
        if [ "${age:-0}" -le "$STALE_PASS_SECONDS" ]; then runs=1; have_ok=1; fi ;;
      failed) n=$((n - 1)) ;; # the same label is retried below
    esac
  fi
  while :; do
    if [ -z "$have_ok" ]; then
      n=$((n + 1))
      start_pass "$n"
      runs=$((runs + 1)); have_ok=1
    fi
    dur=$(field "$REP" duration_s); dur=${dur:-0}
    LAST_DUR=$dur
    used=$(field "$REP" new_used_bytes); used=${used:-0}
    echo "Pass $n took $(fmt_duration "$dur"); $(gib "$used") GiB on the new volume"
    if [ "$dur" -le "$MAX_FINAL" ]; then break; fi
    if [ "$runs" -ge "$PASS_LIMIT" ]; then
      confirm "$runs passes done, the last took $(fmt_duration "$dur") (target $(fmt_duration "$MAX_FINAL")). Continue to the freeze anyway?"
      break
    fi
    have_ok=""
  done
  trap 'exit 130' INT TERM
}

# unfreeze_app: lift the app-level freeze (or unpause the drill containers).
unfreeze_app() {
  if [ "$DRILL" = yes ]; then
    [ -z "$PAUSED" ] || ssh_run "$HOST" "sudo docker unpause $PAUSED" < /dev/null > /dev/null
  else
    ro off > /dev/null
  fi
}

# undo_freeze: everything the freeze step changed, put back. Runs from the EXIT
# trap, so any failure, die or Ctrl-C between the freeze and the swap ends
# here; a second Ctrl-C does not interrupt it.
undo_freeze() {
  local stage=$FREEZE_STAGE
  case "$stage" in none | done) return 0 ;; esac
  FREEZE_STAGE=none
  trap '' INT TERM
  echo
  echo "Undoing the freeze (it had got as far as: $stage)"
  case "$stage" in
    copying | swapping) host stop-copy > /dev/null 2>&1 || echo "WARNING: could not stop the frozen copy; run: ssh $HOST sudo bash $REMOTE stop-copy" ;;
  esac
  case "$stage" in
    disk | copying | swapping) host thaw-disk > /dev/null 2>&1 || echo "WARNING: the old volume may still be read-only; run: ssh $HOST sudo mount -o remount,rw /var/www/blot/data" ;;
  esac
  local i ok=""
  for i in 1 2 3; do
    if unfreeze_app; then ok=1; break; fi
    sleep 2
  done
  if [ -n "$ok" ]; then
    case "$stage" in
      swapped) echo "The swap is done and writes are accepted again, on the NEW volume." ;;
      *) echo "Writes are accepted again, on the OLD volume. Nothing was swapped." ;;
    esac
  else
    echo "WARNING: could not lift the freeze. The app refuses writes until the freeze expires (--freeze-ttl, $FREEZE_TTL s)." >&2
    if [ "$DRILL" = yes ]; then echo "Run: ssh $HOST sudo docker unpause $PAUSED" >&2; else echo "Run: ssh $HOST sudo docker exec $CONTAINER node scripts/read-only.js off" >&2; fi
  fi
}

# refuse_near_cron: host cron and the app scheduler delete files at 01:00 and
# 05:00 UTC (stats pruning, the git quarantine sweep); a freeze then would
# either stall on them or copy a tree that is changing under it.
refuse_near_cron() {
  local hour minute now t diff
  hour=$((10#$(date -u +%H))); minute=$((10#$(date -u +%M)))
  now=$((hour * 60 + minute))
  for t in 60 300; do
    diff=$((now - t)); [ "$diff" -ge 0 ] || diff=$((-diff))
    if [ "$diff" -le 10 ]; then
      if [ -n "$ANY_TIME" ]; then echo "WARNING: within 10 minutes of $((t / 60)):00 UTC (--any-time given)"
      elif [ -n "$DRY_RUN" ]; then echo "NOTE: a real run would refuse now: within 10 minutes of $((t / 60)):00 UTC (host cron and the scheduler delete files then); pass --any-time to override"
      else die "within 10 minutes of $((t / 60)):00 UTC, when host cron and the app scheduler delete files; wait, or pass --any-time"; fi
    fi
  done
}

# step 4: freeze, final copy, snapshot, swap, unfreeze.
step_freeze_and_swap() {
  local t_on t_off out deadline budget snap_tags
  say "4. Freeze, final copy and swap"
  if [ "$DRILL" = yes ]; then
    echo "Drill host: the blot-container-* containers are paused instead of using read-only.js."
  fi
  echo "The app will refuse writes (dashboard and client edits get a 503) for about $(fmt_duration "${LAST_DUR:-0}") or less:"
  echo "the last live pass took that long, and the frozen pass runs in parallel."
  confirm "Freeze now?"
  refuse_near_cron
  aws_cli sts get-caller-identity --query Arn --output text > /dev/null 2>&1 ||
    die "the AWS session expired during the passes; run: aws sso login --profile $AWS_PROFILE_NAME"
  gather_facts

  # Everything from here until the swap is undone by undo_freeze on any
  # failure, die or Ctrl-C.
  t_on=$(date +%s)
  if [ -n "$DRY_RUN" ]; then
    if [ "$DRILL" = yes ]; then echo "would run: docker pause (the blot-container-* containers)"; else echo "would run: docker exec $CONTAINER node scripts/read-only.js on --ttl $FREEZE_TTL --reason 'data volume resize'"; fi
    if [ "$DRILL" != yes ]; then echo "would wait ${GRACE}s, then until lockedBlogs is empty (up to ${LOCK_WAIT}s)"; fi
    host_do freeze-disk 30
    host_do final-copy $((FREEZE_TTL - 90))
    aws_mut ec2 create-snapshot --volume-id "$CUR_VOL" --description "before resize to $NEW_VOL"
    host_do swap
    echo "would lift the freeze and print how long it lasted"
    return 0
  fi
  FREEZE_STAGE=app
  if [ "$DRILL" = yes ]; then
    PAUSED=$(echo "$FACTS" | sed -n 's/^container\.\([^=]*\)=.*/\1/p' | tr '\n' ' ')
    ssh_run "$HOST" "sudo docker pause $PAUSED" < /dev/null > /dev/null || die "docker pause failed"
  else
    out=$(ro on --ttl "$FREEZE_TTL" --reason "'data volume resize'") || die "read-only.js on failed"
    echo "$out" | grep -q '"readOnly":null' && die "the freeze did not take effect: $out"
    echo "Read-only freeze on"
    # The freeze only gates new requests. A dashboard save or a git push that
    # started a moment earlier is still being served, and its folder lock may
    # not even have been taken yet; the grace lets those finish before we look
    # at the locks. The read-only remount below is the hard barrier: it fails
    # while anything still has a file open for writing.
    echo "Waiting ${GRACE}s for requests already in flight"
    sleep "$GRACE"
    deadline=$(($(date +%s) + LOCK_WAIT))
    while :; do
      out=$(ro status) || die "read-only.js status failed"
      echo "$out" | grep -q '"lockedBlogs":\[\]' && break
      [ "$(date +%s)" -lt "$deadline" ] || die "folder locks still held after ${LOCK_WAIT}s: $out"
      sleep 2
    done
    echo "No folder locks held"
  fi

  FREEZE_STAGE=disk
  out=$(host_do freeze-disk 30) || die "the data volume would not go read-only: something is still writing (see above)"
  echo "Old volume read-only ($(field "$out" waited_s)s)"

  FREEZE_STAGE=copying
  if [ "$DRILL" != yes ]; then
    # Restart the TTL clock so the copy gets all of it.
    ro on --ttl "$FREEZE_TTL" --reason "'data volume resize'" > /dev/null || die "could not extend the freeze"
  fi
  budget=$((FREEZE_TTL - 90))
  # The budget leaves 90s of the TTL for the snapshot, the swap and lifting the
  # freeze; final-copy stops itself when it is used up (a drill has no TTL, but
  # keeps the same limit).
  echo "Final copy (parallel)..."
  out=$(host_do final-copy "$budget") || die "the final copy failed (see above)"
  echo "Final copy: $(field "$out" shards) shards in $(fmt_duration "$(field "$out" duration_s)"), $(gib "$(field "$out" new_used_bytes)") GiB on the new volume, inodes $(field "$out" inodes_old) -> $(field "$out" inodes_new) (logs/ and tmp/ contents are not copied)"

  # Taken now, with the old volume at rest and final: this is the rollback.
  snap_tags='{"Key":"Name","Value":"Blot data before resize"},{"Key":"BlotDataVolumeResizeFrom","Value":"'$CUR_VOL'"}'
  [ "$DRILL" != yes ] || snap_tags="$snap_tags"',{"Key":"BlotDrill","Value":"true"}'
  SNAP=$(aws_mut ec2 create-snapshot --volume-id "$CUR_VOL" --description "before resize to $NEW_VOL" \
    --tag-specifications '[{"ResourceType":"snapshot","Tags":['"$snap_tags"']}]' \
    --query SnapshotId --output text) || die "could not start the snapshot of $CUR_VOL"
  echo "Snapshot $SNAP of $CUR_VOL started (not waiting for it)"

  FREEZE_STAGE=swapping
  out=$(host_do swap) || die "the swap failed; the host put the old volume back (see above)"
  echo "$out" | grep -E '^(host|container\.)' | sed 's/^/  sees: /'
  FREEZE_STAGE=swapped
  unfreeze_app || die "the swap is done but the freeze could not be lifted"
  t_off=$(date +%s)
  FREEZE_STAGE=done
  echo "Swapped. Writes are accepted again, on the new volume."
  echo "The app was read-only for $(fmt_duration $((t_off - t_on)))."
  echo "Snapshot of the old volume: $SNAP"
}

# step 5: tags and next steps.
step_retag() {
  local now name
  say "5. Tags"
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  name=$DATA_NAME
  # A drill must never carry the production Name tag: the DLM policy would
  # snapshot it daily.
  if [ "$DRILL" = yes ]; then name=drill-data-volume; fi
  # The new volume first, so there is never a moment with no volume matching the DLM policy.
  aws_mut ec2 create-tags --resources "$NEW_VOL" --tags '[{"Key":"Name","Value":"'"$name"'"}]'
  aws_mut ec2 create-tags --resources "$REPLACED_VOL" --tags '[{"Key":"Name","Value":"Blot data (replaced by '"$NEW_VOL"')"},{"Key":"BlotDataVolumeReplacedAt","Value":"'"$now"'"}]'
  say "Next"
  cat << EOF
 1. Redeploy the proxy so it serves static files from the new volume (it bind-mounts
    only data/static and does not follow the swap; until then it serves the old
    volume, and files missing there fall through to Node, so nothing breaks):
      npm run deploy-proxy
 2. The next app deploy recreates the containers on the new volume.
 3. The old volume ($REPLACED_VOL) stays mounted underneath until the containers
    are recreated and the host is rebooted. Then detach it:
      $0 --host $HOST --profile $AWS_PROFILE_NAME finish
 4. Keep the old volume and the snapshot as the rollback for about a week, then
    delete them by hand. DLM now snapshots the new volume; its first snapshot
    is a full copy, so snapshot cost is roughly doubled for about a week.
EOF
}

cmd_shrink() {
  local need
  REPLACED_VOL=""; NEW_VOL=""; LAST_DUR=0; REP=""

  # An earlier run that swapped but did not finish tagging.
  # (Not retagged: the new volume still has its copy-in-progress name, or the old
  # one lacks its "replaced" tags, e.g. because the second create-tags call failed.)
  local old_replaced=""
  if [ "$PHASE" = swapped ] && [ "$R_NEW" = "$CUR_VOL" ]; then
    old_replaced=$(aws_cli ec2 describe-volumes --volume-ids "$R_OLD" --query 'Volumes[0].Tags[?Key==`BlotDataVolumeReplacedAt`].Value | [0]' --output text 2> /dev/null) || old_replaced=unknown
  fi
  if [ "$PHASE" = swapped ] && [ "$R_NEW" = "$CUR_VOL" ] &&
    { { [ "$CUR_NAME" != "$DATA_NAME" ] && [ "$CUR_NAME" != drill-data-volume ]; } || [ "$old_replaced" = None ]; }; then
    echo "A previous resize from $R_OLD swapped to $CUR_VOL but was not fully retagged: finishing that."
    NEW_VOL=$CUR_VOL; REPLACED_VOL=$R_OLD
    step_retag
    return 0
  fi

  [ "$SIZE" -lt "$CUR_SIZE" ] || die "$SIZE GiB is not smaller than the current $CUR_SIZE GiB (use grow to go larger)"
  # The app must be able to follow the swap and be frozen.
  [ "$PROPAGATION" = shared ] || die "/var/www/blot/data is '$PROPAGATION' on $HOST, not shared: deploy config/host (mount-data-volume) first"
  local found=0 line
  for line in $(echo "$FACTS" | grep '^container\.'); do
    found=1
    [ "${line#*=}" = rslave ] || die "${line%%=*} binds the data directory with '${line#*=}', not rslave: deploy the rslave change first (a deploy recreates the containers)"
  done
  [ "$found" = 1 ] || die "no running blot-container-* on $HOST"
  if [ "$DRILL" != yes ]; then
    ro status > /dev/null || die "'node scripts/read-only.js status' does not work in $CONTAINER: deploy the read-only freeze first"
  fi
  need=$((SIZE * 1073741824 / 100 * 85))
  [ "$USED_B" -le "$need" ] ||
    die "$(gib "$USED_B") GiB used would be $((USED_B * 100 / (SIZE * 1073741824)))% of $SIZE GiB; the limit is 85% (about $(gib "$need") GiB). (The contents of logs/ and tmp/ are not copied, so the new volume will end up a little emptier than this.)"

  case "$PHASE" in
    prepared | copied)
      [ "$R_OLD" = "$CUR_VOL" ] || die "the state file on $HOST is for a resize from $R_OLD, but the current volume is $CUR_VOL"
      NEW_VOL=$R_NEW
      echo "Resuming the resize to $NEW_VOL (phase $PHASE)" ;;
    *)
      local from
      from=$(aws_cli ec2 describe-volumes --filters "Name=tag:BlotDataVolumeResizeFrom,Values=$CUR_VOL" "Name=status,Values=creating,available,in-use" \
        --query 'Volumes[].VolumeId' --output text)
      case "$from" in
        "") ;;
        *[[:space:]]*) die "several volumes are tagged BlotDataVolumeResizeFrom=$CUR_VOL ($from); delete the ones that are not wanted" ;;
        *) NEW_VOL=$from; echo "Found $NEW_VOL, created by an earlier run: resuming with it" ;;
      esac ;;
  esac
  if [ -n "$NEW_VOL" ]; then
    describe_volume "$NEW_VOL"
    [ "$V_SIZE" = "$SIZE" ] || die "the resize in progress is to $V_SIZE GiB ($NEW_VOL), not $SIZE; run it with $V_SIZE, or delete that volume by hand to start over"
    [ "$V_AZ" = "$AZ" ] || die "$NEW_VOL is in $V_AZ, the host is in $AZ"
  fi

  say "Plan: $CUR_VOL ($CUR_SIZE GiB $CUR_TYPE) -> ${NEW_VOL:-a new} volume ($SIZE GiB $VTYPE${IOPS:+, $IOPS IOPS}${THROUGHPUT:+, $THROUGHPUT MiB/s})"
  cat << EOF
 1. create and attach the new volume
 2. format it and mount it at a staging directory on the host
 3. rsync passes while the app runs, until one takes $(fmt_duration "$MAX_FINAL") or less (or $PASS_LIMIT passes)
 4. app read-only ($([ "$DRILL" = yes ] && echo "containers paused" || echo "read-only.js, ${GRACE}s grace, up to ${LOCK_WAIT}s for locks")), old volume remounted read-only,
    parallel final copy, snapshot of the old volume, mount the new volume over the data directory
 5. retag both volumes, print what to do next
EOF
  confirm "Start?"
  step_create_and_attach
  step_prepare
  step_passes
  step_freeze_and_swap
  REPLACED_VOL=$CUR_VOL
  step_retag
}

# Finish
##########################################################

cmd_finish() {
  local old out name replaced_at
  if [ "$PHASE" = swapped ] && [ "$R_NEW" = "$CUR_VOL" ]; then
    old=$R_OLD
  else
    old=$(aws_cli ec2 describe-volumes --filters "Name=attachment.instance-id,Values=$INSTANCE" "Name=tag-key,Values=BlotDataVolumeReplacedAt" \
      --query 'Volumes[].VolumeId' --output text)
    case "$old" in
      "") die "no replaced volume is attached to $INSTANCE: nothing to detach" ;;
      *[[:space:]]*) die "several replaced volumes are attached ($old); detach the ones you want with the AWS CLI" ;;
    esac
  fi
  [ "$old" != "$CUR_VOL" ] || die "$old is the current data volume"
  describe_volume "$old"
  if [ -z "$V_INST" ] || [ "$V_INST" = None ]; then echo "$old is already detached ($V_STATE). Delete it by hand after a week."; return 0; fi
  [ "$V_INST" = "$INSTANCE" ] || die "$old is attached to $V_INST, not to this host's instance"
  name=$V_NAME
  replaced_at=$(aws_cli ec2 describe-volumes --volume-ids "$old" --query 'Volumes[0].Tags[?Key==`BlotDataVolumeReplacedAt`].Value | [0]' --output text)
  case "$name" in "Blot data (replaced by "*")") ;; *) die "$old is named '$name': it was not retagged as replaced; refusing to detach it" ;; esac
  [ -n "$replaced_at" ] && [ "$replaced_at" != None ] || die "$old has no BlotDataVolumeReplacedAt tag; refusing to detach it"

  out=$(host old-volume-status "$old") || die "cannot check the old volume on the host"
  echo "$out" | sed 's/^/  /'
  if [ "$(field "$out" current)" = yes ]; then die "/etc/blot/data-volume on the host still says $old"; fi
  if [ "$(field "$out" mounted)" = yes ]; then
    echo "$old ($name, replaced $replaced_at) is still mounted on $HOST (see above)."
    echo "It is mounted underneath the new volume until the containers are recreated (the next deploy) and the host is rebooted. Run finish again after that."
    return 0
  fi
  confirm "Detach $old from $INSTANCE? (It is not deleted.)"
  aws_mut ec2 detach-volume --volume-id "$old" > /dev/null
  if [ -z "$DRY_RUN" ]; then
    aws_cli ec2 wait volume-available --volume-ids "$old"
    echo "Detached $old. It and the snapshot are the rollback; delete them by hand after about a week."
  fi
}

preflight
case "$CMD" in
  status) cmd_status ;;
  grow) cmd_grow ;;
  shrink) cmd_shrink ;;
  finish) cmd_finish ;;
esac
[ -z "$DRY_RUN" ] || { echo; echo "Dry run: nothing changed."; }
