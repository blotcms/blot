#!/bin/bash
# Usage: resize.sh [options] status
#        resize.sh [options] grow <size-GiB>
#        resize.sh [options] shrink <size-GiB> [--type gp3] [--iops N] [--throughput MiBps]
#        resize.sh [options] finish
#        resize.sh [options] move prepare --to <new-ssh-host> [--existing]
#        resize.sh [options] move copy|freeze|thaw|retag|status
# Resizes the EBS volume mounted at /var/www/blot/data on the app host, or moves
# its contents to another host.
#
#   status   what the host and the volume look like, and any resize in progress
#   grow     online: modify-volume, then xfs_growfs. No freeze, nothing stops.
#   shrink   EBS volumes cannot shrink, so: a new smaller volume is attached,
#            filled with rsync while the app runs, then the app is made
#            read-only for a short window, the last differences are copied and
#            the new volume is mounted over the data directory. Resumable:
#            re-run the same command after Ctrl-C or an error.
#   finish   after a shrink and the app deploy, once no container
#            holds the old volume any more: release the host's own mount of it
#            (no reboot, no downtime; asks first), then detach it. Never
#            deletes.
#   move     the data goes to ANOTHER host, with --host as the source. The new
#            host gets a volume made from a snapshot and filled with rsync
#            while the old host keeps serving; writes stop only for the final
#            pass. In order:
#              prepare  snapshot, new volume in the new host's zone, attach,
#                       stage it, start a pre-warm, set up the copy's ssh key
#                       (--existing: the new host already has its volume, a
#                       move back)
#              copy     live passes, as in a shrink
#              freeze   read-only, final pass, then STOP with the app frozen
#                       and the source read-only: the switch (cycle.sh) goes on
#              thaw     undo the freeze if there is no switch
#              retag    after the switch: production tags on the new volume
#            status shows where it is. Nothing is swapped or detached; the old
#            host and its volume stay as the rollback.
#
# Read config/host/data-volume/README.md first, and rehearse with drill.sh.
# Needs the read-only freeze (scripts/read-only.js) and the rslave data bind
# deployed, and /etc/blot/data-volume on the host (config/host/deploy.sh).
#
# Options:
#   --host SSH_HOST          the app host (default blot)
#   --profile NAME           AWS CLI profile (default blot)   --region NAME (default us-west-2)
#   --container NAME         the container read-only.js runs in (default blot-blue, a unit)
#   --lock-wait SECONDS      how long to wait for held folder locks to drain (default 120)
#   --grace SECONDS          how long to wait after the freeze starts before
#                            looking at the folder locks (default 15)
#   --max-final-seconds N    stop the live passes once one takes this long or
#                            less (default 300); after 5 passes you are asked
#   --freeze-ttl SECONDS     how long the read-only freeze lasts if this script
#                            dies (default 900); the frozen copy must fit in it
#   --any-time               allow the freeze within 10 minutes of 01:00 and 05:00 UTC
#   --app-freeze             on a drill host, freeze with read-only.js as production does
#                            rather than pausing the containers (a drill with real units)
#   --to SSH_HOST            move prepare: the new host (as ssh reaches it from here)
#   --existing               move prepare: the new host already has its data volume mounted
#   --no-prewarm-check       move freeze: do not require the pre-warm to have finished
#   --yes                    do not ask for confirmation
#   --dry-run                run every read-only check and print every step;
#                            change nothing (only /tmp/blot-data-volume/host.sh
#                            is copied to the host, which the checks need; a move
#                            prepare copies it to the new host too)
# shrink and move prepare: --type gp3|gp2 (default gp3), --iops N, --throughput MiBps (gp3).
# Without --iops and --throughput a gp3 volume gets the included 3000 IOPS and
# 125 MiB/s, which is enough (README, "Cost").
set -euo pipefail
. "$(dirname "$0")/lib.sh"

HOST=blot
AWS_PROFILE_NAME=blot
AWS_REGION=${AWS_REGION:-us-west-2}
CONTAINER=blot-blue
LOCK_WAIT=120
GRACE=15
# A live pass is one rsync walking the whole tree; the frozen pass walks it in
# parallel shards, so it takes well under the last live pass. Five minutes of
# live pass is a frozen pass of about a minute or less.
MAX_FINAL=300
FREEZE_TTL=900
ANY_TIME=""; APP_FREEZE=""; PAUSE_UNITS=""; YES=""; DRY_RUN=""
VTYPE=gp3; IOPS=""; THROUGHPUT=""
CMD=""; SIZE=""; MSUB=""
TO=""; EXISTING=""; NO_PREWARM_CHECK=""

REMOTE=/tmp/blot-data-volume/host.sh
DATA_NAME="Blot /var/www/blot/data" # the Name tag the DLM snapshot policy targets
INIT_RATE=300                       # MiB/s, EBS's highest provisioned rate for loading a snapshot; billed per GiB
FREEZE_REASON="data volume resize"  # what read-only.js on shows; a move says so in its own
PASS_LIMIT=5                        # live passes before we ask
STALE_PASS_SECONDS=1800             # a finished pass older than this does not count on a resume
PLACEHOLDER_VOLUME=vol-00000000000000000

while [ $# -gt 0 ]; do
  case "$1" in
    --host | --profile | --region | --container | --to | --lock-wait | --grace | --max-final-seconds | --freeze-ttl | --type | --iops | --throughput)
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
    --app-freeze) APP_FREEZE=1; shift ;;
    --to) TO=$2; shift 2 ;;
    --existing) EXISTING=1; shift ;;
    --no-prewarm-check) NO_PREWARM_CHECK=1; shift ;;
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
case "$CMD" in status | grow | shrink | finish | move) ;; *) die "usage: resize.sh [options] status|grow <GiB>|shrink <GiB>|finish|move prepare|copy|freeze|thaw|retag|status" ;; esac
case "$LOCK_WAIT$GRACE$MAX_FINAL$FREEZE_TTL$IOPS$THROUGHPUT" in *[!0-9]*) die "--lock-wait, --grace, --max-final-seconds, --freeze-ttl, --iops and --throughput take numbers" ;; esac
case "$VTYPE" in gp2 | gp3) ;; *) die "--type must be gp3 or gp2" ;; esac
# The final copy gets FREEZE_TTL minus 90 seconds (for the snapshot, the swap
# and lifting the freeze) as its time limit, so the TTL has to leave a real one.
[ "$FREEZE_TTL" -ge 300 ] || die "--freeze-ttl must be at least 300 seconds (the final copy gets the TTL minus 90 s as its time limit)"
if [ "$CMD" = grow ] || [ "$CMD" = shrink ]; then
  case "$SIZE" in "" | *[!0-9]*) die "$CMD needs a size in GiB, e.g. resize.sh $CMD 600" ;; esac
elif [ "$CMD" = move ]; then
  case "$SIZE" in prepare | copy | freeze | thaw | retag | status) MSUB=$SIZE ;; *) die "usage: resize.sh [options] move prepare --to <new-ssh-host> [--existing] | copy | freeze | thaw | retag | status" ;; esac
elif [ -n "$SIZE" ]; then
  die "unexpected argument $SIZE"
fi
[ -z "$TO$EXISTING" ] || { [ "$CMD" = move ] && [ "$MSUB" = prepare ]; } || die "--to and --existing are for move prepare"
[ -z "$NO_PREWARM_CHECK" ] || { [ "$CMD" = move ] && [ "$MSUB" = freeze ]; } || die "--no-prewarm-check is for move freeze"
[ "$CMD" != move ] || [ "$MSUB" != prepare ] || [ -n "$TO" ] || die "move prepare needs --to <the new host, as ssh reaches it>"
[ -z "$TO" ] || [ "$TO" != "$HOST" ] || die "--to is the same as --host"
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
  for h in $HOST $TO; do ssh -o ControlPath="$CTL/%C" -O exit "$h" > /dev/null 2>&1 || true; done
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
  # A drill host pauses its stand-in containers instead of freezing the app,
  # unless it runs real units (--app-freeze).
  PAUSE_UNITS=$DRILL; [ -z "$APP_FREEZE" ] || PAUSE_UNITS=no
  PHASE=$(field "$FACTS" resize_phase); R_OLD=$(field "$FACTS" resize_old); R_NEW=$(field "$FACTS" resize_new)
  TARGET=$(field "$FACTS" resize_target); R_EXIST=$(field "$FACTS" resize_existing)
  SRC_IP=$(field "$FACTS" private_ip)
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
  [ "$(field "$FACTS" mounted_volume)" = "$CUR_VOL" ] ||
    die "/etc/blot/data-volume says $CUR_VOL, but the volume mounted at /var/www/blot/data is '$(field "$FACTS" mounted_volume)'"
  [ "$(field "$FACTS" mounted_marker)" = "$CUR_VOL" ] ||
    die "the mounted data volume's .blot-data-volume says '$(field "$FACTS" mounted_marker)', expected $CUR_VOL"
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
  case "$PHASE" in prepared | copied) die "a $([ -n "$TARGET" ] && echo move || echo shrink) is in progress ($R_NEW); finish or abandon it first" ;; esac
  # After a shrink the old volume is still mounted underneath until `finish`.
  # xfs_growfs takes its target size from the first mount listed there, the old
  # volume, and exits 0 at that size. Refuse before spending the 6-hour EBS change.
  [ "$(field "$FACTS" data_mounts)" = 1 ] ||
    die "the old volume is still mounted under $CUR_VOL: run the app deploy and resize.sh finish first"
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
    # A dry run attached nothing, so there is nothing to wait for.
    [ -z "$DRY_RUN" ] || return 0
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
  # An earlier run that got as far as the final copy and was interrupted: the
  # state is copied and the data directory is still read-only (prepare keeps
  # phase=copied only then), so there is nothing to copy live. Go straight on
  # to the freeze, whose freeze-disk is a no-op on a read-only mount and whose
  # final-copy accepts phase=copied.
  gather_facts
  case ",$(field "$FACTS" options)," in
    *,ro,*)
      if [ "$PHASE" = copied ]; then
        echo "The host is already at phase=copied with the data directory read-only (an interrupted run): no live pass, on to the freeze."
        LAST_DUR=0
        return 0
      fi ;;
  esac
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
  if [ "$PAUSE_UNITS" = yes ]; then
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
    if [ "$PAUSE_UNITS" = yes ]; then echo "Run: ssh $HOST sudo docker unpause $PAUSED" >&2; else echo "Run: ssh $HOST sudo docker exec $CONTAINER node scripts/read-only.js off" >&2; fi
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

# The freeze, shared by a shrink and a move. freeze_dry_run prints it; freeze_app
# stops the app writing (FREEZE_STAGE=app); freeze_and_copy makes the disk
# read-only (disk) and runs the frozen copy (copying). The caller decides what
# happens next, and undo_freeze puts things back from whatever stage was reached.
freeze_dry_run() {
  if [ "$PAUSE_UNITS" = yes ]; then echo "would run: docker pause (blot-blue and blot-green)"; else echo "would run: docker exec $CONTAINER node scripts/read-only.js on --ttl $FREEZE_TTL --reason '$FREEZE_REASON'"; fi
  if [ "$PAUSE_UNITS" != yes ]; then echo "would wait ${GRACE}s, then until lockedBlogs is empty (up to ${LOCK_WAIT}s)"; fi
  host_do freeze-disk 30
  host_do final-copy $((FREEZE_TTL - 90))
}

freeze_app() {
  local out deadline
  FREEZE_STAGE=app
  if [ "$PAUSE_UNITS" = yes ]; then
    PAUSED=$(echo "$FACTS" | sed -n 's/^container\.\([^=]*\)=.*/\1/p' | tr '\n' ' ')
    # (a container left paused by an interrupted run counts as paused)
    ssh_run "$HOST" 'for c in '"$PAUSED"'; do sudo docker pause "$c" > /dev/null 2>&1 || [ "$(sudo docker inspect -f "{{.State.Paused}}" "$c")" = true ] || exit 1; done' < /dev/null || die "docker pause failed"
  else
    out=$(ro on --ttl "$FREEZE_TTL" --reason "'$FREEZE_REASON'") || die "read-only.js on failed"
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
}

freeze_and_copy() {
  local out budget
  FREEZE_STAGE=disk
  out=$(host_do freeze-disk 30) || die "the data volume would not go read-only: something is still writing (see above)"
  echo "Old volume read-only ($(field "$out" waited_s)s)"

  FREEZE_STAGE=copying
  if [ "$PAUSE_UNITS" != yes ]; then
    # Restart the TTL clock so the copy gets all of it.
    ro on --ttl "$FREEZE_TTL" --reason "'$FREEZE_REASON'" > /dev/null || die "could not extend the freeze"
    T_REARM=$(date +%s)
  fi
  budget=$((FREEZE_TTL - 90))
  # The budget leaves 90s of the TTL for the snapshot, the swap and lifting the
  # freeze; final-copy stops itself when it is used up (a drill has no TTL, but
  # keeps the same limit).
  echo "Final copy (parallel)..."
  out=$(host_do final-copy "$budget") || die "the final copy failed (see above)"
  echo "Final copy: $(field "$out" shards) shards in $(fmt_duration "$(field "$out" duration_s)"), $(gib "$(field "$out" new_used_bytes)") GiB on the new volume, inodes $(field "$out" inodes_old) -> $(field "$out" inodes_new) (logs/ and tmp/ contents are not copied)"
}

# step 4: freeze, final copy, snapshot, swap, unfreeze.
step_freeze_and_swap() {
  local t_on t_off out snap_tags
  say "4. Freeze, final copy and swap"
  if [ "$PAUSE_UNITS" = yes ]; then
    echo "Drill host: the units (blot-blue and blot-green) are paused instead of using read-only.js."
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
    freeze_dry_run
    aws_mut ec2 create-snapshot --volume-id "$CUR_VOL" --description "before resize to $NEW_VOL"
    host_do swap
    echo "would lift the freeze and print how long it lasted"
    return 0
  fi
  freeze_app
  freeze_and_copy

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
 1. The next app deploy recreates the containers on the new volume:
      npm run deploy-units
 2. The old volume ($REPLACED_VOL) stays mounted underneath the new one until the
    app deploy has recreated every container. Then finish releases
    the host's own mount of it (no reboot, no downtime) and detaches it:
      $0 --host $HOST --profile $AWS_PROFILE_NAME finish
 3. Keep the old volume and the snapshot as the rollback for about a week, then
    delete them by hand. DLM now snapshots the new volume; its first snapshot
    is a full copy, so snapshot cost is roughly doubled for about a week.
EOF
}

cmd_shrink() {
  local need
  REPLACED_VOL=""; NEW_VOL=""; LAST_DUR=0; REP=""
  case "$PHASE" in prepared | copied) [ -z "$TARGET" ] || die "a move to $TARGET is in progress ($R_NEW); finish it (move retag) or undo it (move thaw) first" ;; esac

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
  local found=0 line out
  for line in $(echo "$FACTS" | grep '^container\.'); do
    found=1
    [ "${line#*=}" = rslave ] || die "${line%%=*} binds the data directory with '${line#*=}', not rslave: deploy the rslave change first (a deploy recreates the containers)"
  done
  [ "$found" = 1 ] || die "no running blot-blue or blot-green on $HOST"
  if [ "$PAUSE_UNITS" != yes ]; then
    out=$(ro status) || die "'node scripts/read-only.js status' does not work in $CONTAINER: deploy the read-only freeze first"
    # A freeze that is already on belongs to someone else unless it is ours
    # from an interrupted run; lifting it at the end would end their freeze.
    if ! echo "$out" | grep -q '"readOnly":null' && ! echo "$out" | grep -q '"reason":"data volume resize"'; then
      die "the app is already read-only for something else: $out"
    fi
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
 4. app read-only ($([ "$PAUSE_UNITS" = yes ] && echo "containers paused" || echo "read-only.js, ${GRACE}s grace, up to ${LOCK_WAIT}s for locks")), old volume remounted read-only,
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
  if { [ "$PHASE" = swapped ] || [ "$PHASE" = released ]; } && [ "$R_NEW" = "$CUR_VOL" ]; then
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
    if [ "$(field "$out" mounted_elsewhere)" != 0 ]; then
      # A container keeps the mounts it was created with, the old volume under
      # the new one, until it is recreated.
      echo "Containers still hold it (the holder= lines above). A deploy recreates them; run finish again after:"
      echo "  npm run deploy-units    for blot-blue and blot-green"
      return 0
    fi
    # Only the host's own namespace has it, stacked under the new volume, and
    # maybe sandboxed services whose copies follow the host's (follower=).
    if [ "$(field "$out" mounted_following)" != 0 ]; then
      echo "The follower= namespaces above (sandboxed services) mount it as a slave of the host's mount,"
      echo "so the host's umount takes it from them too; release-old checks that it did."
    fi
    echo "Only the host itself still has it mounted, under the new volume. release-old unmounts both"
    echo "from the host and mounts the current volume again: no downtime, the containers keep running"
    echo "on their own copies; their link to the host's mounts comes back with the next app deploy."
    confirm "Release it now?"
    out=$(host_do release-old "$old") || die "release-old failed (see above, and the state it describes)"
    echo "$out" | sed 's/^/  /'
    # (A dry run released nothing: go on to show the detach.)
    if [ -z "$DRY_RUN" ]; then
      out=$(host old-volume-status "$old") || die "cannot check the old volume on the host"
      if [ "$(field "$out" mounted)" = yes ] || [ "$(field "$out" mounted_elsewhere)" != 0 ] || [ "$(field "$out" mounted_following)" != 0 ]; then
        echo "$old is still mounted on $HOST after the release:"
        echo "$out" | sed 's/^/  /'
        return 0
      fi
    fi
  fi
  confirm "Detach $old from $INSTANCE? (It is not deleted.)"
  aws_mut ec2 detach-volume --volume-id "$old" > /dev/null
  if [ -z "$DRY_RUN" ]; then
    aws_cli ec2 wait volume-available --volume-ids "$old"
    echo "Detached $old. It and the snapshot are the rollback; delete them by hand after about a week."
  fi
}

# Move to another host
##########################################################

# The data goes to a second host with a volume made from a snapshot and topped
# up with rsync, so the old host serves until the Elastic IP moves and writes
# stop only for the final pass. Detaching the volume and attaching it to the
# new host is not an option: the old host would lose its folder files and
# uncached renders for minutes. The freeze, passes and undo are the shrink's own.

SNAP_MAX_AGE=172800 # seconds; an older "before move" snapshot is not reused

# thost <subcommand>: host.sh on the NEW host (--to); thost_do for one that changes something.
thost() { ssh_run "$TO" "sudo bash $REMOTE $*" < /dev/null; }
thost_do() { ssh_run "$TO" "sudo bash $REMOTE ${DRY_RUN:+--dry-run} $*" < /dev/null; }

# move_need <message>: a precondition. A dry run may not have prepared
# anything yet, so there it is only a note.
move_need() {
  if [ -n "$DRY_RUN" ]; then echo "NOTE: a real run would stop here: $1"; else die "$1"; fi
}

# epoch <ISO time>: seconds since 1970 (GNU date, or the Mac's).
epoch() { date -u -d "$1" +%s 2> /dev/null || date -j -u -f '%Y-%m-%dT%H:%M:%S' "${1%%.*}" +%s; }

# move_state: the move this host is part of, checked against the live volume.
move_state() {
  [ -n "$TARGET" ] || { move_need "no move is prepared on $HOST: run move prepare --to <new host> first"; return 0; }
  [ "$R_OLD" = "$CUR_VOL" ] || die "the state file on $HOST is for a move from $R_OLD, but the current volume is $CUR_VOL"
  NEW_VOL=$R_NEW
}

# move_target_status: sets MS to host.sh move-status (state, plus what the target
# says when the source reaches it with the move key) and checks it can be used.
move_target_status() {
  MS=$(host move-status) || die "cannot run move-status on $HOST"
  [ -z "$TARGET" ] || [ -n "$DRY_RUN" ] || {
    [ "$(field "$MS" ssh)" = ok ] || die "$HOST cannot ssh to $TARGET with its move key ($(field "$MS" ssh_error)). The target's security group must let $HOST's private address in on its ssh port"
    [ "$(field "$MS" sudo)" = ok ] || die "ec2-user on $TARGET has no passwordless sudo"
    [ "$(field "$MS" rsync)" = ok ] || die "rsync is not installed on $TARGET (sudo rsync failed)"
  }
}

# attach_first_free <volume> <instance>: attach at the first free /dev/sdf../dev/sdp.
attach_first_free() {
  local used letter dev att i
  aws_cli ec2 wait volume-available --volume-ids "$1"
  used=$(aws_cli ec2 describe-instances --instance-ids "$2" --query 'Reservations[0].Instances[0].BlockDeviceMappings[].DeviceName' --output text | tr '\t' ' ')
  dev=""
  for letter in f g h i j k l m n o p; do
    case " $used " in *" /dev/sd$letter "* | *" /dev/xvd$letter "*) ;; *) dev=/dev/sd$letter; break ;; esac
  done
  [ -n "$dev" ] || die "no free device name between /dev/sdf and /dev/sdp on $2 (in use: $used)"
  aws_cli ec2 attach-volume --volume-id "$1" --instance-id "$2" --device "$dev" > /dev/null
  echo "Attached as $dev"
  aws_cli ec2 wait volume-in-use --volume-ids "$1"
  for ((i = 0; i < 60; i++)); do
    att=$(aws_cli ec2 describe-volumes --volume-ids "$1" --query 'Volumes[0].Attachments[0].State' --output text)
    [ "$att" != attached ] || break
    sleep 2
  done
  [ "$att" = attached ] || die "$1 is '$att', not attached"
}

# prepare, step 1: the snapshot. It is the source of the new volume and the
# first rollback. SNAP is set.
move_snapshot() {
  local row tags age
  say "2. Snapshot of $CUR_VOL"
  row=$(aws_cli ec2 describe-snapshots --owner-ids self \
    --filters "Name=tag:BlotDataVolumeMoveFrom,Values=$CUR_VOL" "Name=tag:Name,Values=Blot data before move" "Name=status,Values=pending,completed" \
    --query 'sort_by(Snapshots,&StartTime)[-1].[SnapshotId,StartTime]' --output text)
  SNAP=""
  case "$row" in
    "" | None*) ;;
    *)
      age=$(($(date +%s) - $(epoch "${row#*$'\t'}")))
      if [ "$age" -le "$SNAP_MAX_AGE" ]; then
        SNAP=${row%%$'\t'*}
        echo "Using $SNAP, taken $(fmt_duration "$age") ago"
      else
        echo "$(echo "$row" | cut -f1) is older than $(fmt_duration "$SNAP_MAX_AGE"): taking a new one"
      fi ;;
  esac
  if [ -z "$SNAP" ]; then
    tags='{"Key":"Name","Value":"Blot data before move"},{"Key":"BlotDataVolumeMoveFrom","Value":"'$CUR_VOL'"}'
    [ "$DRILL" != yes ] || tags="$tags"',{"Key":"BlotDrill","Value":"true"}'
    confirm "Snapshot $CUR_VOL? (It is the source of the new volume and the first rollback; this host keeps serving.)"
    SNAP=$(aws_mut ec2 create-snapshot --volume-id "$CUR_VOL" --description "before move to $T_INSTANCE" \
      --tag-specifications '[{"ResourceType":"snapshot","Tags":['"$tags"']}]' --query SnapshotId --output text) ||
      die "could not start the snapshot of $CUR_VOL"
    if [ -n "$DRY_RUN" ]; then SNAP=snap-00000000000000000; return 0; fi
    echo "Started $SNAP"
  fi
  # (a snapshot of a large volume takes a long time; the AWS waiter gives up after 10 minutes)
  local st pr
  while :; do
    row=$(aws_cli ec2 describe-snapshots --snapshot-ids "$SNAP" --query 'Snapshots[0].[State,Progress]' --output text)
    st=${row%%$'\t'*}; pr=${row#*$'\t'}
    case "$st" in
      completed) break ;;
      pending) echo "  snapshot: $pr" ;;
      *) die "$SNAP is '$st'" ;;
    esac
    sleep 30
  done
  echo "$SNAP completed"
}

# prepare, step 2: the volume, in the new host's zone, attached to it. NEW_VOL is set.
move_create_and_attach() {
  local tags name opts
  say "3. The new volume (in $T_AZ, attached to $T_INSTANCE)"
  if [ -z "$NEW_VOL" ]; then
    name="Blot data (copy in progress)"
    [ "$DRILL" != yes ] || name=drill-data-volume # never the production Name: DLM would snapshot it
    tags='{"Key":"Name","Value":"'"$name"'"},{"Key":"BlotDataVolumeMoveFrom","Value":"'$CUR_VOL'"}'
    [ "$DRILL" != yes ] || tags="$tags"',{"Key":"BlotDrill","Value":"true"}'
    # Without a rate, blocks load from S3 only as they are read, far too slowly for
    # the pre-warm's dd, and move freeze waits for it.
    opts="--snapshot-id $SNAP --availability-zone $T_AZ --size $CUR_SIZE --volume-type $VTYPE --volume-initialization-rate $INIT_RATE"
    [ -z "$IOPS" ] || opts="$opts --iops $IOPS"
    [ -z "$THROUGHPUT" ] || opts="$opts --throughput $THROUGHPUT"
    [ "$CUR_ENC" != True ] || opts="$opts --encrypted"
    [ "$CUR_ENC" != True ] || [ "$CUR_KMS" = None ] || opts="$opts --kms-key-id $CUR_KMS"
    confirm "Create a $CUR_SIZE GiB $VTYPE volume from $SNAP in $T_AZ (encrypted: $CUR_ENC, loading at $INIT_RATE MiB/s) and attach it to $T_INSTANCE?"
    # shellcheck disable=SC2086
    NEW_VOL=$(aws_mut ec2 create-volume $opts --tag-specifications '[{"ResourceType":"volume","Tags":['"$tags"']}]' --query VolumeId --output text)
    if [ -n "$DRY_RUN" ]; then
      NEW_VOL=$PLACEHOLDER_VOLUME
      aws_mut ec2 wait volume-available --volume-ids "$NEW_VOL"
      aws_mut ec2 attach-volume --volume-id "$NEW_VOL" --instance-id "$T_INSTANCE" --device "/dev/sdf (first free of /dev/sdf../dev/sdp)"
      return 0
    fi
    echo "Created $NEW_VOL"
  else
    echo "Using $NEW_VOL (already created)"
  fi
  describe_volume "$NEW_VOL"
  if [ -n "$V_INST" ] && [ "$V_INST" != None ]; then
    [ "$V_INST" = "$T_INSTANCE" ] || die "$NEW_VOL is attached to $V_INST, not to the new host's instance $T_INSTANCE"
  else
    attach_first_free "$NEW_VOL" "$T_INSTANCE"
  fi
}

cmd_move_prepare() {
  local TF T_INSTANCE T_AZ T_IP T_PORT T_KEY T_DRILL out pub t resume=""
  NEW_VOL=""; SNAP=""
  case "$PHASE" in
    prepared | copied)
      [ -n "$TARGET" ] || die "a shrink to $R_NEW is in progress; finish or abandon it first"
      [ "$R_OLD" = "$CUR_VOL" ] || die "the state file on $HOST is for a move from $R_OLD, but the current volume is $CUR_VOL"
      resume=1 ;;
    swapped) die "a shrink swapped to $R_NEW and was not finished: run finish first" ;;
  esac

  say "Checking $TO"
  push_host_script "$TO" || die "cannot copy host.sh to $TO"
  TF=$(thost facts) || die "cannot run host.sh on $TO (ssh, or passwordless sudo)"
  T_INSTANCE=$(field "$TF" instance_id); T_AZ=$(field "$TF" az); T_IP=$(field "$TF" private_ip)
  T_PORT=$(field "$TF" ssh_port); T_KEY=$(field "$TF" ssh_hostkey); T_DRILL=$(field "$TF" drill)
  [ -n "$T_INSTANCE" ] && [ -n "$T_AZ" ] && [ -n "$T_IP" ] || die "$TO did not report its instance ID, zone and address (IMDS)"
  [ "$T_INSTANCE" != "$INSTANCE" ] || die "$TO is the same instance as $HOST"
  [ "$T_DRILL" = "$DRILL" ] || die "$HOST is $([ "$DRILL" = yes ] || echo not\ )a drill host but $TO is $([ "$T_DRILL" = yes ] || echo not\ )one; a drill and production never mix"
  [ -n "$T_KEY" ] || die "$TO has no /etc/ssh/ssh_host_ed25519_key.pub, so $HOST cannot check its identity"
  [ "$(field "$TF" rsync)" = yes ] || die "rsync is not installed on $TO"
  # A move back before retag: the old host still records its move to this host.
  case "$(field "$TF" resize_phase)" in
    prepared | copied)
      t=$(field "$TF" resize_target); t=${t#*@}
      [ -n "$EXISTING" ] && [ "${t%:*}" = "$SRC_IP" ] ||
        die "$TO has a resize or move in progress of its own (phase $(field "$TF" resize_phase))" ;;
  esac
  [ "$T_AZ" = "$AZ" ] || echo "NOTE: $TO is in $T_AZ and $HOST in $AZ. The copy crosses zones; the plan keeps both in one."
  if [ -n "$resume" ]; then
    [ "$TARGET" = "ec2-user@$T_IP:$T_PORT" ] || die "the move in progress goes to $TARGET, but $TO is ec2-user@$T_IP:$T_PORT"
    NEW_VOL=$R_NEW
    [ "$R_EXIST" != yes ] || EXISTING=1
    echo "Resuming the move to $NEW_VOL (phase $PHASE)"
  fi

  if [ -n "$EXISTING" ]; then
    NEW_VOL=$(field "$TF" volume_id)
    [[ "$NEW_VOL" =~ ^vol-[0-9a-f]{8,17}$ ]] || die "/etc/blot/data-volume on $TO does not hold a volume ID ('$NEW_VOL')"
    [ "$(field "$TF" mountpoint)" = yes ] || die "/var/www/blot/data is not mounted on $TO (--existing is for a host that already has its volume)"
    [ "$(field "$TF" mounted_volume)" = "$NEW_VOL" ] && [ "$(field "$TF" mounted_marker)" = "$NEW_VOL" ] ||
      die "the volume mounted at /var/www/blot/data on $TO is '$(field "$TF" mounted_volume)' with marker '$(field "$TF" mounted_marker)', expected $NEW_VOL"
    case ",$(field "$TF" options)," in *,ro,*) die "$TO's data directory is read-only: thaw it first (move thaw on that host)" ;; esac
    [ "$NEW_VOL" != "$CUR_VOL" ] || die "$TO has the same volume as $HOST"
  else
    # A resumed move may already be mounted there, by the Next step below.
    [ "$(field "$TF" mountpoint)" != yes ] || [ "$(field "$TF" mounted_volume)" = "$NEW_VOL" ] ||
      die "$TO already has a volume mounted at /var/www/blot/data; use --existing to copy into it"
    if [ -z "$NEW_VOL" ]; then
      NEW_VOL=$(aws_cli ec2 describe-volumes --filters "Name=tag:BlotDataVolumeMoveFrom,Values=$CUR_VOL" "Name=status,Values=creating,available,in-use" \
        --query 'Volumes[].VolumeId' --output text)
      case "$NEW_VOL" in
        "") ;;
        *[[:space:]]*) die "several volumes are tagged BlotDataVolumeMoveFrom=$CUR_VOL ($NEW_VOL); delete the ones that are not wanted" ;;
        *) echo "Found $NEW_VOL, created by an earlier run: resuming with it" ;;
      esac
    fi
    if [ -n "$NEW_VOL" ]; then
      describe_volume "$NEW_VOL"
      [ "$V_AZ" = "$T_AZ" ] || die "$NEW_VOL is in $V_AZ, $TO is in $T_AZ; delete that volume by hand to start over"
    fi
  fi

  say "Plan: $CUR_VOL on $HOST -> ${NEW_VOL:-a new volume} on $TO ($T_INSTANCE, $T_AZ)"
  if [ -n "$EXISTING" ]; then
    cat << EOF
 1. $TO already has its volume ($NEW_VOL): no snapshot, no new volume, no pre-warm
 2. make a key on $HOST for the copy and let it into ec2-user on $TO (from $HOST's address only)
EOF
  else
    cat << EOF
 1. snapshot $CUR_VOL (tagged BlotDataVolumeMoveFrom): the source of the new volume and the first rollback
 2. create ${NEW_VOL:-a $VTYPE volume} from it in $T_AZ, with the same size and encryption, and attach it to $T_INSTANCE.
    It is not named for the snapshot policy (DLM) until move retag.
 3. on $TO: write the new volume's own ID into its marker (host.sh adopt; never formats)
 4. on $TO: read the whole device once in the background (blot-data-prewarm): a volume made from a
    snapshot loads from S3 on first read, and the switch must not be the first read
 5. make a key on $HOST for the copy and let it into ec2-user on $TO (from $HOST's address only)
EOF
  fi
  confirm "Start?"

  if [ -z "$EXISTING" ]; then
    move_snapshot
    move_create_and_attach
    say "4. Staging $NEW_VOL on $TO, and warming it"
    out=$(thost_do adopt "$NEW_VOL" "$CUR_VOL") || die "adopt failed on $TO (see above)"
    echo "$out"
    out=$(thost_do prewarm "$NEW_VOL") || die "could not start the pre-warm on $TO"
    echo "$out"
  fi

  say "5. The copy's ssh key"
  out=$(host_do move-prepare "$T_IP" "$T_PORT" "$NEW_VOL" "$T_KEY" ${EXISTING:+existing}) || die "move-prepare failed on $HOST"
  if [ -n "$DRY_RUN" ]; then
    echo "$out"
    echo "would let the key into ec2-user's authorized_keys on $TO, from $SRC_IP"
  else
    pub=$(field "$out" public_key)
    # shellcheck disable=SC2086
    set -- $pub
    [ "$1" = ssh-ed25519 ] && [ -n "${2:-}" ] || die "$HOST did not return a public key ($pub)"
    thost_do authorize-key "$SRC_IP" "$1" "$2" > /dev/null || die "could not let the key into $TO"
    # move-prepare wrote the state on the host: without this TARGET is still
    # empty on a first run and move_target_status checks nothing.
    gather_facts
    move_target_status
    echo "$HOST reaches $TO over ssh, with passwordless sudo and rsync"
  fi

  say "Next"
  if [ -z "$EXISTING" ]; then
    if [ "$DRILL" = yes ]; then
      cat << EOF
 1. $TO has no deploy.sh in a drill; mount the volume the way it would:
      ssh $TO 'echo $NEW_VOL | sudo tee /etc/blot/data-volume && sudo systemctl enable --now mount-data-volume.service'
EOF
    else
      cat << EOF
 1. Mount it on $TO through mount-data-volume.service. A new host runs deploy.sh directly (not
    npm run deploy-host, which sources the old host's address); see config/host/launch.sh:
      DATA_VOLUME_ID=$NEW_VOL SSH_KEY=<key> PUBLIC_IP=<$TO's address> SSH_PORT=<its port> config/host/deploy.sh
EOF
    fi
  else
    echo " 1. $TO already has its volume mounted."
  fi
  cat << EOF
 2. Copy while $HOST keeps serving:
      $0 --host $HOST move copy
 3. Then, once the pre-warm is done (move status): the freeze.
      $0 --host $HOST move freeze
EOF
}

# prewarm_line: one line on the pre-warm, from a move-status in MS.
prewarm_line() {
  local st dur pct
  st=$(field "$MS" target_prewarm); dur=$(field "$MS" target_prewarm_duration_s); pct=$(field "$MS" target_prewarm_percent)
  if [ "$R_EXIST" = yes ]; then echo "Pre-warm:   not needed (the target already had its volume)"; return 0; fi
  case "$st" in
    running) echo "Pre-warm:   running for $(fmt_duration "${dur:-0}"), ${pct:-?}% read" ;;
    ok) echo "Pre-warm:   done in $(fmt_duration "${dur:-0}")" ;;
    *) echo "Pre-warm:   ${st:-unknown}" ;;
  esac
}

cmd_move_status() {
  local l
  if [ -z "$TARGET" ]; then
    echo "No move is recorded on $HOST (state: ${PHASE:-none})."
    return 0
  fi
  move_target_status_soft
  echo "Move:       $R_OLD on $HOST -> $R_NEW at $TARGET, phase $PHASE$([ "$R_EXIST" != yes ] || echo ", target already had its volume")"
  echo "Data dir:   $(field "$FACTS" options)"
  if [ "$(field "$MS" ssh)" = ok ]; then
    echo "Target:     reachable; volume mounted there '$(field "$MS" target_mounted_volume)', marker '$(field "$MS" target_mounted_marker)'$([ "$(field "$MS" target_mounted_volume)" = "$R_NEW" ] && echo " (as expected)" || echo " (NOT $R_NEW: deploy.sh has not mounted it yet?)")"
    prewarm_line
  else
    echo "Target:     not reachable from $HOST: $(field "$MS" ssh_error)"
  fi
  for l in $(field "$FACTS" copy_labels); do
    echo
    echo "Copy pass $l:"
    host copy-status "$l" | sed 's/^/  /'
  done
}
# (status looks, it never dies on a target it cannot reach)
move_target_status_soft() { MS=$(host move-status) || die "cannot run move-status on $HOST"; }

cmd_move_copy() {
  local v
  move_state
  [ -n "$TARGET" ] || return 0
  case ",$(field "$FACTS" options)," in
    *,ro,*) die "the data directory is read-only: the freeze is on. Undo it with move thaw, or go on with the switch" ;;
  esac
  [ "$PHASE" = prepared ] || die "phase is '$PHASE', not prepared: re-run move prepare --to <new host>"
  move_target_status
  if [ -z "$DRY_RUN" ]; then
    v=$(field "$MS" target_mounted_volume)
    [ "$v" = "$NEW_VOL" ] && [ "$(field "$MS" target_mounted_marker)" = "$NEW_VOL" ] ||
      die "the volume mounted at /var/www/blot/data on the target is '$v' with marker '$(field "$MS" target_mounted_marker)', not $NEW_VOL: mount it first (the Next step of move prepare)"
    case ",$(field "$MS" target_options)," in *,ro,*) die "the target's data directory is read-only" ;; esac
    prewarm_line
  fi
  confirm "Copy from $HOST to $TARGET while the app keeps running?"
  step_passes
  if [ -z "$DRY_RUN" ]; then
    move_target_status
    prewarm_line
  fi
  echo
  echo "Next: $0 --host $HOST move freeze"
}

cmd_move_freeze() {
  local t_on left snap_tags pw rostat
  FREEZE_REASON="data volume move"
  move_state
  [ -n "$TARGET" ] || return 0
  case "$PHASE" in prepared | copied) ;; *) move_need "phase is '$PHASE', not prepared" ;; esac
  move_target_status
  if [ -z "$DRY_RUN" ]; then
    [ "$(field "$MS" target_mounted_volume)" = "$NEW_VOL" ] && [ "$(field "$MS" target_mounted_marker)" = "$NEW_VOL" ] ||
      die "the volume mounted at /var/www/blot/data on the target is '$(field "$MS" target_mounted_volume)', not $NEW_VOL"
    pw=$(field "$MS" target_prewarm)
    # EBS says when a volume has finished loading, long before the dd gets there.
    if [ "$pw" != ok ] && [ "$(aws_cli ec2 describe-volume-status --volume-ids "$NEW_VOL" --query 'VolumeStatuses[0].InitializationStatusDetails.Progress' --output text 2> /dev/null || true)" = 100 ]; then
      echo "EBS reports $NEW_VOL fully loaded, so the pre-warm ('$pw') has nothing left to do"
      pw=ok
    fi
    if [ "$R_EXIST" != yes ] && [ "$pw" != ok ]; then
      if [ -n "$NO_PREWARM_CHECK" ]; then echo "WARNING: the pre-warm is '$pw' (--no-prewarm-check given): the first reads on the new volume will be slow"
      else die "the pre-warm on the target is '${pw:-unknown}' ($(field "$MS" target_prewarm_percent)%): wait for it (move status), or pass --no-prewarm-check"; fi
    fi
  fi
  case ",$(field "$FACTS" options)," in
    *,ro,*)
      if [ "$PHASE" = copied ]; then
        echo "The data directory is already read-only and the final copy is done: the freeze is on. Undo it with move thaw, or go on with the switch."
        return 0
      fi ;;
  esac
  if [ "$PAUSE_UNITS" != yes ] && [ -z "$DRY_RUN" ]; then
    rostat=$(ro status) || die "'node scripts/read-only.js status' does not work in $CONTAINER"
    if ! echo "$rostat" | grep -q '"readOnly":null' && ! echo "$rostat" | grep -q '"reason":"data volume move"'; then
      die "the app is already read-only for something else: $rostat"
    fi
  fi

  say "Freeze and final copy"
  if [ "$PAUSE_UNITS" = yes ]; then
    echo "Drill host: the units (blot-blue and blot-green) are paused instead of using read-only.js."
  fi
  echo "The app will refuse writes (dashboard and client edits get a 503) from now until the switch or move thaw,"
  echo "which is much longer than a shrink's window: this stops after the final copy with everything still frozen."
  echo "The last live pass took $(fmt_duration "$(highest_pass_duration)"); the frozen pass runs in parallel and is shorter."
  confirm "Freeze now?"
  refuse_near_cron
  aws_cli sts get-caller-identity --query Arn --output text > /dev/null 2>&1 ||
    die "the AWS session expired; run: aws sso login --profile $AWS_PROFILE_NAME"
  gather_facts

  t_on=$(date +%s)
  if [ -n "$DRY_RUN" ]; then
    freeze_dry_run
    aws_mut ec2 create-snapshot --volume-id "$CUR_VOL" --description "at move freeze, to $NEW_VOL"
    echo "would stop there, with the app frozen and the data directory read-only, and print how long the freeze has left"
    return 0
  fi
  # Until the final copy and the snapshot are done, undo_freeze puts everything back.
  freeze_app
  freeze_and_copy

  snap_tags='{"Key":"Name","Value":"Blot data at move freeze"},{"Key":"BlotDataVolumeMoveFrom","Value":"'$CUR_VOL'"}'
  [ "$DRILL" != yes ] || snap_tags="$snap_tags"',{"Key":"BlotDrill","Value":"true"}'
  SNAP=$(aws_mut ec2 create-snapshot --volume-id "$CUR_VOL" --description "at move freeze, to $NEW_VOL" \
    --tag-specifications '[{"ResourceType":"snapshot","Tags":['"$snap_tags"']}]' \
    --query SnapshotId --output text) || die "could not start the snapshot of $CUR_VOL"
  echo "Snapshot $SNAP of $CUR_VOL started (not waiting for it)"

  # From here the EXIT trap leaves the freeze alone.
  FREEZE_STAGE=done
  echo
  echo "FROZEN. The final copy is on $TARGET; $HOST's data directory is read-only and the app refuses writes."
  echo "The frozen part so far took $(fmt_duration $(($(date +%s) - t_on)))."
  if [ "$PAUSE_UNITS" = yes ]; then
    echo "The drill units stay paused until the switch or: $0 --host $HOST move thaw"
  else
    left=$((FREEZE_TTL - ($(date +%s) - T_REARM)))
    echo "The read-only freeze lapses by itself in about $(fmt_duration "$left") (--freeze-ttl $FREEZE_TTL); the switch has to"
    echo "re-arm it (read-only.js on --ttl) or finish first. If it lapses with the disk still read-only, writes fail with"
    echo "errors instead of 503s."
  fi
  echo "Go on with the switch, or undo: $0 --host $HOST move thaw"
}

# highest_pass_duration: how long the newest finished pass took.
highest_pass_duration() {
  local n
  n=$(highest_pass)
  if [ "$n" -gt 0 ]; then field "$(host copy-status "p$n")" duration_s | sed 's/^$/0/'; else echo 0; fi
}

cmd_move_thaw() {
  local c out i ok=""
  move_state
  [ -n "$TARGET" ] || return 0
  say "Thawing $HOST"
  host_do stop-copy
  host_do thaw-disk
  echo "Data directory read-write again."
  [ -z "$DRY_RUN" ] || { echo "would lift the app freeze (or unpause the drill containers)"; return 0; }
  if [ "$PAUSE_UNITS" = yes ]; then
    for c in $(echo "$FACTS" | sed -n 's/^container\.\([^=]*\)=.*/\1/p'); do
      ssh_run "$HOST" "sudo docker unpause $c" < /dev/null > /dev/null 2>&1 || true
    done
    echo "Drill containers unpaused."
    # A drill that ran real units froze with --app-freeze, and thaw does not get
    # that flag from a later command: lift our own freeze, recognised by its
    # reason. Stand-in containers have no read-only.js, which is not an error.
    if out=$(ro status 2> /dev/null) && echo "$out" | grep -q '"reason":"data volume move"'; then
      ro off > /dev/null || die "could not lift the freeze; run: ssh $HOST sudo docker exec $CONTAINER node scripts/read-only.js off"
      echo "Freeze lifted: the app accepts writes again."
    fi
    return 0
  fi
  if ! out=$(ro status); then
    echo "WARNING: could not run read-only.js in $CONTAINER (stopped?). A freeze that is still on lapses by itself after its TTL."
    return 0
  fi
  if echo "$out" | grep -q '"readOnly":null'; then
    echo "The app was not frozen."
  elif echo "$out" | grep -q '"reason":"data volume move"'; then
    for i in 1 2 3; do
      if ro off > /dev/null; then ok=1; break; fi
      sleep 2
    done
    [ -n "$ok" ] || die "could not lift the freeze; run: ssh $HOST sudo docker exec $CONTAINER node scripts/read-only.js off"
    echo "Freeze lifted: the app accepts writes again."
  else
    echo "The app is read-only for something else, which is left alone: $out"
  fi
}

cmd_move_retag() {
  local now name
  move_state
  [ -n "$TARGET" ] || return 0
  case "$PHASE" in copied | moved) ;; *) move_need "phase is '$PHASE': move retag is for after the switch, once move freeze has finished" ;; esac
  if [ -z "$DRY_RUN" ]; then
    describe_volume "$NEW_VOL"
    [ -n "$V_INST" ] && [ "$V_INST" != None ] || die "$NEW_VOL is not attached to any instance"
    [ "$V_INST" != "$INSTANCE" ] || die "$NEW_VOL is attached to $HOST itself"
  fi
  say "Retag: $NEW_VOL becomes the data volume, $CUR_VOL is replaced"
  echo "Run this after the switch. --host must be the OLD host by an address that still reaches it"
  echo "(an alias for the Elastic IP now points at the new host)."
  confirm "Retag?"
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  name=$DATA_NAME
  # A drill must never carry the production Name tag: the DLM policy would snapshot it.
  if [ "$DRILL" = yes ]; then name=drill-data-volume; fi
  # The new volume first, so there is never a moment with no volume matching the DLM policy.
  aws_mut ec2 create-tags --resources "$NEW_VOL" --tags '[{"Key":"Name","Value":"'"$name"'"}]'
  aws_mut ec2 create-tags --resources "$CUR_VOL" --tags '[{"Key":"Name","Value":"Blot data (replaced by '"$NEW_VOL"')"},{"Key":"BlotDataVolumeReplacedAt","Value":"'"$now"'"}]'
  host_do move-done
  say "Next"
  cat << EOF
 $HOST stays as the rollback, with $CUR_VOL mounted read-only and nothing detached or deleted,
 until the cycle's finish. To go back before then: thaw $HOST (move thaw), then from the new host
 move prepare --to <the old host> --existing, copy and freeze (README, "Moving to another host").
EOF
}

cmd_move() {
  case "$MSUB" in
    prepare) cmd_move_prepare ;;
    copy) cmd_move_copy ;;
    freeze) cmd_move_freeze ;;
    thaw) cmd_move_thaw ;;
    retag) cmd_move_retag ;;
    status) cmd_move_status ;;
  esac
}

preflight
case "$CMD" in
  status) cmd_status ;;
  grow) cmd_grow ;;
  shrink) cmd_shrink ;;
  finish) cmd_finish ;;
  move) cmd_move ;;
esac
[ -z "$DRY_RUN" ] || { echo; echo "Dry run: nothing changed."; }
