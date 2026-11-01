#!/bin/bash
# Runs ON the app host, as root; resize.sh pushes it to /tmp/blot-data-volume/
# and calls it over ssh:
#
#   sudo bash /tmp/blot-data-volume/host.sh [--dry-run] <subcommand> [args]
#
#   facts                      what resize.sh needs to know about the host
#   prepare <new-volume-id>    format (or recognise) and stage the new volume
#   copy <label>               start a live rsync pass in the background
#   copy-status <label>        how that pass is doing
#   final-copy [seconds]       the frozen pass (foreground, parallel)
#   freeze-disk <seconds>      remount the data volume read-only
#   thaw-disk                  remount it read-write (rollback)
#   swap                       move the new volume over the data directory
#   stop-copy                  stop any copy still running (rollback)
#   old-volume-status <id>     is the old volume still mounted anywhere, and where?
#   release-old <id>           unmount the old volume from the host, no reboot
#   grow-fs <size-bytes>       xfs_growfs after an online EBS grow
#
# A move to another host (resize.sh move) uses the same copy and freeze
# subcommands with the target's data directory as the destination, and these:
#
#   adopt <volume-id> [old-id] on the NEW host: stage a volume made from a snapshot and
#                              put its own ID in its marker (never formats)
#   prewarm <volume-id>        on the NEW host: read the whole device once, in the background
#   authorize-key <ip> <type> <key>   on the NEW host: let the source's move key in
#   deauthorize-key            on the NEW host: take it out again
#   move-prepare <ip> <port> <volume-id> <host-key> [existing]
#                              on the SOURCE: make the move key and record the move
#   move-status                on the SOURCE: the move's state, and what the target says
#   move-done                  on the SOURCE: after the switch, forget the target and the key
#
# Every subcommand prints key=value lines on stdout (resize.sh parses them with
# field(), like config/redis/promote.sh's gather) and anything else on stderr.
# A non-zero exit is a failure. --dry-run runs the checks that only read and
# prints what the rest would do.
#
# Why a mount swap and not a rename: the app containers bind the data directory
# with bind-propagation=rslave (config/host/scripts/mount-data-volume.sh makes
# the host mount shared), so a mount made on the host over the data directory
# shows up inside running containers at once. The old volume stays mounted
# underneath, read-only, until the containers are recreated; on the host it
# can be released without a reboot (release-old).
set -euo pipefail

DATA=/var/www/blot/data
CONTAINER_DATA=/usr/src/app/data
ID_FILE=/etc/blot/data-volume
STATE=/etc/blot/data-volume-resize.state
# The staging directory must be a PRIVATE mount of itself: "mount --move"
# refuses to move a mount that sits under a shared mount, and / is shared on a
# systemd host.
STAGING=/mnt/blot-data-staging
NEW_MNT=$STAGING/new
# A move to another host: the source's key for the target, and the target's host
# key. resize.sh move prepare creates them, move retag removes them.
MOVE_KEY=/etc/blot/data-move-key
MOVE_KNOWN_HOSTS=/etc/blot/data-move-known-hosts
MOVE_KEY_COMMENT=blot-data-move
PREWARM_UNIT=blot-data-prewarm
MARKER=.blot-data-volume
LINK_PREFIX=/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol
UNIT_PREFIX=blot-data-copy-
LOCK=/run/blot-data-volume.lock
# Installed by config/host/deploy.sh; release-old uses it to mount the current
# volume again.
MOUNT_SCRIPT=/home/ec2-user/scripts/mount-data-volume.sh
# The top-level directories whose children are copied by separate rsyncs in the
# frozen pass (final-copy). Everything else at the top level is one rsync.
SHARD_PARENTS=${SHARD_PARENTS:-"static blogs git"}
# For a move all the frozen rsyncs share one ssh connection, and sshd allows 10
# sessions per connection by default, so this has to stay below 10.
FINAL_COPY_JOBS=${FINAL_COPY_JOBS:-8}

DRY_RUN=""
work="" # final-copy's scratch directory (global: the EXIT trap and shard_copy use it)
if [ "${1:-}" = "--dry-run" ]; then DRY_RUN=1; shift; fi

die() { echo "error: $*" >&2; exit 1; }
plan() { echo "would: $*"; }

# What is copied, shared by the live passes and the frozen pass. Archive mode
# (-a) with -H hard links, -A ACLs, -X xattrs, -S sparse files, numeric ids:
# an exact copy, nothing mapped through this host's user database. --delete
# propagates deletions, so a blog deleted between passes is gone from the new
# volume too (without it the new volume would only ever grow). Not
# --delete-excluded: what is excluded below is simply never copied, and
# anything already there is none of rsync's business. That matters most for a
# move: the target's own marker and its logs/ and tmp/ must survive every pass.
# Not --inplace: it cannot be combined with -S, and sparse files must stay
# sparse or the used size would balloon on a smaller volume.
#
# The contents of logs/ and tmp/ are skipped (the directories are kept: cron
# appends to logs/expiring-certs.log; the app's own tmp is on the instance
# store now, so tmp/ here is only a leftover). The
# marker is skipped so the new volume keeps its own, which prepare wrote and
# mount-data-volume.sh checks.
RSYNC_OPTS=(-aHAXS --numeric-ids --delete)
RSYNC_EXCLUDES=('--exclude=/.blot-data-volume' '--exclude=/logs/*' '--exclude=/tmp/*')

# Small helpers
##########################################################

is_volume_id() { [[ "${1:-}" =~ ^vol-[0-9a-f]{8,17}$ ]]; }
is_ip() { local re='^[0-9]+(\.[0-9]+){3}$'; [[ "${1:-}" =~ $re ]]; }
valid_volume() { is_volume_id "${1:-}" || die "not a volume ID: '${1:-}'"; }
volume_link() { echo "${LINK_PREFIX}${1#vol-}"; }
current_volume() { tr -d '[:space:]' < "$ID_FILE" 2> /dev/null || true; }
# <major>:<minor> of a block device, as /proc/*/mountinfo prints it.
devno() { printf '%d:%d' "0x$(stat -L -c %t "$1")" "0x$(stat -L -c %T "$1")"; }
# The mount points of a device in any mount namespace on the host (every
# container has its own), one per line. A bind mount of the same filesystem
# shows the same device number.
mounts_of() { { cat /proc/[0-9]*/mountinfo 2> /dev/null || true; } | awk -v d="$1" '$3 == d {print $5}' | sort -u; }
# The mounts at the data directory in the host's own mount namespace.
data_mount_count() { awk -v d="$DATA" '$5 == d' /proc/self/mountinfo | wc -l | tr -d ' '; }
# scan_mounts <major:minor>: where a device is mounted, by mount namespace.
# Sets M_HOST (yes|no: the host's namespace, pid 1's, has it) and M_OTHERS: one
# "holder=<pid> <comm>[ (container <name>)]" line for each OTHER namespace that
# has it (a container's namespace is created by docker, and keeps what it
# inherited when it was created: the old volume, stacked under the new one).
# One process per namespace is enough; for a container it is the one docker
# reports, so the name can be given.
#
# A service started with systemd sandboxing (PrivateTmp=, ProtectSystem=, e.g.
# chronyd) has its own namespace too, but there the device is mounted at the
# data directory as a slave of the host's own mount (master:N, N being the
# host mount's shared:N), so the host's umount reaches it. Those go in
# M_FOLLOWERS ("follower=<pid> <comm>") instead: they don't block a release,
# but they must be gone after it.
scan_mounts() {
  local no=$1 host_ns map="" c row cpid cname d p ns seen=" " hit peers
  host_ns=$(readlink /proc/1/ns/mnt)
  if awk -v d="$no" '$3 == d {f = 1} END {exit !f}' /proc/1/mountinfo; then M_HOST=yes; else M_HOST=no; fi
  # The host's peer groups at the data directory
  peers=" $(awk -v m="$DATA" '$5 == m {for (i = 7; $i != "-"; i++) if ($i ~ /^shared:/) printf "%s ", substr($i, 8)}' /proc/1/mountinfo)"
  M_OTHERS=""
  M_FOLLOWERS=""
  if have docker; then
    for c in $(docker ps -q 2> /dev/null || true); do
      row=$(docker inspect -f '{{.State.Pid}} {{.Name}}' "$c" 2> /dev/null || true)
      cpid=${row%% *}; cname=${row#* }; cname=${cname#/}
      [ -n "$cpid" ] && [ "$cpid" != 0 ] || continue
      ns=$(readlink "/proc/$cpid/ns/mnt" 2> /dev/null) || continue
      map="$map$ns|$cpid|$cname"$'\n'
    done
  fi
  for d in /proc/[0-9]*; do
    p=${d#/proc/}
    ns=$(readlink "$d/ns/mnt" 2> /dev/null) || continue
    [ "$ns" != "$host_ns" ] || continue
    case "$seen" in *" $ns "*) continue ;; esac
    [ -r "$d/mountinfo" ] || continue # the process just exited: another one in its namespace will do
    seen="$seen$ns "
    awk -v d="$no" '$3 == d {f = 1} END {exit !f}' "$d/mountinfo" 2> /dev/null || continue
    # Every mount of the device there is a slave of the host's at the same place
    if awk -v d="$no" -v m="$DATA" -v peers="$peers" '
      $3 == d {
        ok = 0
        if ($5 == m) for (i = 7; $i != "-"; i++) if ($i ~ /^master:/ && index(peers, " " substr($i, 8) " ")) ok = 1
        if (!ok) bad = 1
      }
      END {exit bad}' "$d/mountinfo" 2> /dev/null; then
      M_FOLLOWERS="$M_FOLLOWERS""follower=$p $(tr -d '\n' < "$d/comm" 2> /dev/null || echo '?')"$'\n'
      continue
    fi
    hit=$(printf '%s' "$map" | awk -F'|' -v n="$ns" '$1 == n {print $2 "|" $3; exit}')
    if [ -n "$hit" ]; then
      cpid=${hit%%|*}; cname=${hit#*|}
      M_OTHERS="$M_OTHERS""holder=$cpid $(tr -d '\n' < "/proc/$cpid/comm" 2> /dev/null || echo '?') (container $cname)"$'\n'
    else
      M_OTHERS="$M_OTHERS""holder=$p $(tr -d '\n' < "$d/comm" 2> /dev/null || echo '?')"$'\n'
    fi
  done
  M_OTHERS=${M_OTHERS%$'\n'}
  M_FOLLOWERS=${M_FOLLOWERS%$'\n'}
}
# findmnt -o <column> for the topmost mount at the data directory. Stacked
# mounts (after a swap) print one line each; the last one is the one in use.
# AL2's findmnt takes one target per call.
data_mount() { findmnt -n -o "$1" --target "$DATA" 2> /dev/null | tail -n 1 || true; }
# findmnt prints a bind-mounted source as /dev/xxx[/subdir]: drop the [...].
data_device() { readlink -f "$(data_mount SOURCE | sed 's/\[.*//')"; }
# The vol-... ID of the EBS volume whose device is mounted at the data
# directory, from the by-id links; empty if none matches.
mounted_volume() {
  local dev link
  dev=$(data_device)
  for link in "$LINK_PREFIX"*; do
    case "$link" in *-ns-* | *-part*) continue ;; esac
    [ "$(readlink -f "$link")" = "$dev" ] && { echo "vol-${link#"$LINK_PREFIX"}"; return 0; }
  done
}
read_marker() { { tr -d '[:space:]' < "$1/$MARKER"; } 2> /dev/null || true; }
now_mono() { awk '{print int($1)}' /proc/uptime; }
containers() { command -v docker > /dev/null && docker ps --format '{{.Names}}' | grep -E '^blot-(blue|green)$' || true; }

state_get() { awk -F= -v k="$1" '$1 == k {print substr($0, length(k) + 2)}' "$STATE" 2> /dev/null || true; }
# Written to a temp file and renamed so a crash never leaves half a file.
# A move adds a target line (<user>@<ip>:<port>, where the data goes) and, when the
# target already had its volume, existing=yes. A shrink writes neither.
state_write() {
  mkdir -p "$(dirname "$STATE")"
  printf 'old_volume=%s\nnew_volume=%s\nphase=%s\n' "$1" "$2" "$3" > "$STATE.tmp"
  [ -z "${4:-}" ] || printf 'target=%s\n' "$4" >> "$STATE.tmp"
  [ -z "${5:-}" ] || printf 'existing=%s\n' "$5" >> "$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
}
have() { command -v "$1" > /dev/null; }
# phase_in <phase>...: is the recorded phase one of these?
phase_in() { local p x; p=$(state_get phase); for x in "$@"; do [ "$p" != "$x" ] || return 0; done; return 1; }
set_phase() { state_write "$(state_get old_volume)" "$(state_get new_volume)" "$1" "$(state_get target)" "$(state_get existing)"; }
is_move() { [ -n "$(state_get target)" ]; }

# One run at a time that touches the data or the staging mount. The lock file
# descriptor is inherited by the rsyncs, so an orphaned rsync keeps the lock
# until stop-copy kills it.
take_lock() {
  exec 9> "$LOCK"
  flock -n 9 || die "another data-volume command is running on this host (holding $LOCK)"
}

# precondition <message> <command...>: a check that must hold for a real run.
# A dry run may not have prepared anything (a fresh "shrink --dry-run" has no
# state file and no staging mount), so there a failed check is only a note and
# the dry run goes on to print every step.
precondition() {
  local msg=$1
  shift
  "$@" && return 0
  if [ -n "$DRY_RUN" ]; then echo "note: a real run would stop here: $msg" >&2; else die "$msg"; fi
}

# Where a copy writes and how it gets there. A shrink writes to the staging
# mount. A move writes over ssh to the target's data directory, with the key
# move-prepare made, as ec2-user and `sudo rsync` on the other side (root login
# is off, and files must keep their owners). Sets COPY_DEST (ends in a slash),
# XFER_HOST, XFER_SSH (the ssh command, also used for rsync -e) and XFER_RSYNC;
# the last three are empty for a shrink. Exported for the xargs children.
#
# The host key is checked against the one resize.sh read from the target over
# its own ssh (move-prepare), not accepted on first use: Amazon Linux 2's ssh
# 7.4 has no StrictHostKeyChecking=accept-new anyway.
set_dest() {
  local t hostport ip port
  t=$(state_get target)
  if [ -z "$t" ]; then
    COPY_DEST=$NEW_MNT/; XFER_HOST=""; XFER_SSH=""; XFER_RSYNC=""
  else
    hostport=${t#*@}; ip=${hostport%:*}; port=${hostport##*:}
    COPY_DEST="${t%:*}:$DATA/"
    XFER_HOST=${t%:*}
    XFER_SSH="ssh -i $MOVE_KEY -p $port -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$MOVE_KNOWN_HOSTS -o HostKeyAlgorithms=ssh-ed25519 -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6"
    XFER_RSYNC="sudo rsync"
  fi
  export COPY_DEST XFER_HOST XFER_SSH XFER_RSYNC
}
# xfer_opts: rsync's transport options in XFER, empty for a shrink. (Callers
# expand it as ${XFER[@]+"${XFER[@]}"}: Amazon Linux 2's bash 4.2 fails on an
# empty array under set -u.) Exported for the xargs children.
xfer_opts() {
  XFER=()
  [ -z "${XFER_SSH:-}" ] || XFER=(-e "$XFER_SSH" --rsync-path="$XFER_RSYNC")
}
# tssh <command>: run a command on the move target over XFER_SSH (call set_dest first).
tssh() { $XFER_SSH "$XFER_HOST" "$@"; }
# on_target <subcommand> [args]: run one of THIS script's subcommands on the move
# target, as root there, without it being installed: the script is sent on stdin
# and run from a temp file (not `bash -s`: a command that reads stdin would eat
# the rest of the script).
on_target() {
  set_dest
  # shellcheck disable=SC2086
  $XFER_SSH "$XFER_HOST" 'f=$(mktemp /tmp/blot-host.XXXXXX) && cat > "$f" && sudo bash "$f" '"$*"'; rc=$?; rm -f "$f"; exit $rc' < "${BASH_SOURCE[0]}"
}

# Kills the rsyncs of a shrink (they write to NEW_MNT) and of a move (they write
# to the target's data directory).
stop_rsyncs() {
  pkill -TERM -f "rsync .*$NEW_MNT" || true
  if is_move; then
    set_dest
    pkill -TERM -f "rsync .*$COPY_DEST" || true
  fi
}

# sd <unit> <property>: one property of a systemd unit. systemd 219 (Amazon
# Linux 2) has no "systemctl show --value".
sd() { systemctl show "$1" -p "$2" 2> /dev/null | sed "s/^$2=//"; }

# unit_state <unit>: none | running | ok | failed
unit_state() {
  local load active sub
  load=$(sd "$1" LoadState); active=$(sd "$1" ActiveState); sub=$(sd "$1" SubState)
  if [ "$load" != loaded ]; then echo none
  elif [ "$active" = failed ]; then echo failed
  elif [ "$active" = active ] && [ "$sub" = exited ]; then echo ok
  elif [ "$active" = active ] || [ "$active" = activating ] || [ "$active" = deactivating ]; then echo running
  else echo none; fi
}

copy_units() { systemctl list-units --all --plain --no-legend "${UNIT_PREFIX}*" 2> /dev/null | awk '{print $1}'; }

# facts
##########################################################

# The port sshd listens on (the app host's is not 22).
sshd_port() {
  local p
  p=$({ sshd -T 2> /dev/null || true; } | awk '$1 == "port" {print $2; exit}')
  [ -n "$p" ] || p=$(awk '$1 == "Port" {print $2; exit}' /etc/ssh/sshd_config 2> /dev/null || true)
  echo "${p:-22}"
}

# prewarm_report: the state of the pre-warm unit as key=value. A volume made from
# a snapshot loads from S3 on first read, so one dd over the whole device
# (started by prewarm) makes the first real read fast. The device is in the
# unit's description; progress is the bytes dd has read so far.
prewarm_report() {
  local st pid dev size rchar="" pct="" start_us exit_us now dur=""
  st=$(unit_state "$PREWARM_UNIT.service")
  echo "prewarm=$st"
  [ "$st" != none ] || return 0
  dev=$(sd "$PREWARM_UNIT.service" Description)
  dev=${dev##* of }
  size=$(blockdev --getsize64 "$dev" 2> /dev/null || true)
  if [ "$st" = ok ]; then
    pct=100
  elif [ "$st" = running ]; then
    pid=$(sd "$PREWARM_UNIT.service" MainPID)
    [ "${pid:-0}" -gt 0 ] && rchar=$(awk '$1 == "rchar:" {print $2}' "/proc/$pid/io" 2> /dev/null || true)
    [ -z "$rchar" ] || [ -z "$size" ] || pct=$((rchar * 100 / size))
  fi
  echo "prewarm_percent=$pct"
  start_us=$(sd "$PREWARM_UNIT.service" ExecMainStartTimestampMonotonic)
  exit_us=$(sd "$PREWARM_UNIT.service" ExecMainExitTimestampMonotonic)
  now=$(now_mono)
  if [ "$st" = running ]; then
    [ "${start_us:-0}" -gt 0 ] && dur=$((now - start_us / 1000000))
  elif [ "${start_us:-0}" -gt 0 ] && [ "${exit_us:-0}" -gt 0 ]; then
    dur=$(((exit_us - start_us) / 1000000))
  fi
  echo "prewarm_duration_s=$dur"
}

cmd_facts() {
  local token size used avail
  token=$(curl -sf -m 3 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' || true)
  imds() { curl -sf -m 3 -H "X-aws-ec2-metadata-token: $token" "http://169.254.169.254/latest/meta-data/$1" || true; }
  echo "instance_id=$(imds instance-id)"
  echo "az=$(imds placement/availability-zone)"
  echo "volume_id=$(current_volume)"
  if mountpoint -q "$DATA"; then
    echo mountpoint=yes
    echo "source=$(data_mount SOURCE | sed 's/\[.*//')"
    echo "data_mounts=$(awk -v d="$DATA" '$5 == d' /proc/self/mountinfo | wc -l)"
    # Which EBS volume is really mounted there (the topmost mount), and the
    # marker it carries: resize.sh checks both against /etc/blot/data-volume
    # before changing anything, so a stale ID file can't point it at another
    # volume attached to this instance.
    echo "mounted_volume=$(mounted_volume)"
    echo "mounted_marker=$(read_marker "$DATA")"
    echo "propagation=$(data_mount PROPAGATION)"
    echo "fstype=$(data_mount FSTYPE)"
    echo "options=$(data_mount OPTIONS)"
    read -r size used avail < <(df -B1 --output=size,used,avail "$DATA" | tail -n 1)
    echo "size_bytes=$size"
    echo "used_bytes=$used"
    echo "avail_bytes=$avail"
    echo "inodes_used=$(df --output=iused "$DATA" | tail -n 1 | tr -d ' ')"
  else
    echo mountpoint=no
  fi
  if [ -e /etc/blot/drill ]; then echo drill=yes; else echo drill=no; fi
  local c prop
  for c in $(containers); do
    prop=$(docker inspect -f "{{range .Mounts}}{{if eq .Destination \"$CONTAINER_DATA\"}}{{.Propagation}}{{end}}{{end}}" "$c" 2> /dev/null || true)
    echo "container.$c=${prop:-none}"
  done
  echo "resize_phase=$(state_get phase)"
  echo "resize_old=$(state_get old_volume)"
  echo "resize_new=$(state_get new_volume)"
  echo "resize_target=$(state_get target)"
  echo "resize_existing=$(state_get existing)"
  # For a move: what resize.sh needs to know about the host, whichever end it is.
  echo "private_ip=$(imds local-ipv4)"
  echo "ssh_port=$(sshd_port)"
  echo "ssh_hostkey=$(awk '{print $2}' /etc/ssh/ssh_host_ed25519_key.pub 2> /dev/null || true)"
  prewarm_report
  echo "copy_labels=$(copy_units | sed "s/^$UNIT_PREFIX//; s/\.service$//" | tr '\n' ' ')"
  if command -v rsync > /dev/null; then echo rsync=yes; else echo rsync=no; fi
  if command -v mkfs.xfs > /dev/null && command -v xfs_growfs > /dev/null; then echo xfsprogs=yes; else echo xfsprogs=no; fi
}

# prepare
##########################################################

cmd_prepare() {
  local new=${1:-} cur phase link dev no others fstype marker label resumed=""
  valid_volume "$new"
  cur=$(current_volume)
  [ "$new" != "$cur" ] || die "$new is the current data volume"
  phase=$(state_get phase)
  case "$phase" in
    prepared | copied)
      ! is_move || die "a move to $(state_get target) is in progress (state file $STATE); finish or abandon it first"
      [ "$(state_get new_volume)" = "$new" ] ||
        die "a resize to $(state_get new_volume) is already in progress (state file $STATE)"
      [ "$(state_get old_volume)" = "$cur" ] || die "$STATE says the old volume is $(state_get old_volume), the current one is $cur"
      resumed=1 ;;
  esac

  link=$(volume_link "$new")
  if [ -n "$DRY_RUN" ]; then
    if [ -e "$link" ]; then echo "device=$(readlink -f "$link")"; else echo "device=absent"; fi
    plan "wait up to 120s for $link; refuse if it is mounted anywhere except $NEW_MNT"
    plan "mkfs.xfs -L blotdata on it if blank (or accept an XFS whose $MARKER says $new)"
    plan "mount --bind $STAGING $STAGING && mount --make-private $STAGING; mount -o noatime the device at $NEW_MNT"
    plan "write $new to $NEW_MNT/$MARKER and record old=$cur new=$new phase=prepared in $STATE (a resumed phase=copied stays only while $DATA is read-only)"
    return 0
  fi
  take_lock

  local i
  for ((i = 0; i < 120; i++)); do
    [ -e "$link" ] && break
    sleep 1
  done
  [ -e "$link" ] || die "$link did not appear within 120s: is $new attached to this instance?"
  dev=$(readlink -f "$link")
  no=$(devno "$dev")
  others=$(mounts_of "$no" | grep -vx "$NEW_MNT" || true)
  [ -z "$others" ] || die "$new ($dev) is mounted at: $(echo "$others" | tr '\n' ' ')"

  mkdir -p "$STAGING"
  mountpoint -q "$STAGING" || mount --bind "$STAGING" "$STAGING"
  mount --make-private "$STAGING"
  mkdir -p "$NEW_MNT"

  if ! mountpoint -q "$NEW_MNT"; then
    fstype=$(blkid -p -o value -s TYPE "$dev" 2> /dev/null || true)
    if [ -z "$fstype" ]; then
      # Blank. mkfs.xfs itself also refuses a device that has any signature,
      # which is the second line of defence against formatting the wrong disk.
      [ -z "$(blkid -p -o value -s PTTYPE "$dev" 2> /dev/null || true)" ] || die "$dev has a partition table"
      mkfs.xfs -L blotdata "$dev" > /dev/null
      echo "filesystem=created"
    elif [ "$fstype" = xfs ]; then
      echo "filesystem=existing"
    else
      die "$dev already has a '$fstype' filesystem; refusing to touch it"
    fi
    # noatime to match mount-data-volume.sh: the options of this mount are the
    # ones the volume keeps after the move.
    mount -o noatime "$dev" "$NEW_MNT"
  fi

  marker=$(read_marker "$NEW_MNT")
  label=$(blkid -p -o value -s LABEL "$dev" 2> /dev/null || true)
  if [ "$marker" = "$new" ]; then
    :
  elif [ -z "$marker" ] && [ "$label" = blotdata ] && [ -z "$(ls -A "$NEW_MNT")" ]; then
    # What an earlier prepare leaves if it died between mkfs and the marker:
    # our label and nothing on the filesystem at all.
    :
  else
    umount "$NEW_MNT" || true
    die "$dev holds an XFS filesystem that is not this resize's (marker '$marker', expected $new); refusing to use it"
  fi
  echo "$new" > "$NEW_MNT/$MARKER"

  if [ -z "$resumed" ]; then
    # A fresh resize: forget passes of an earlier one (their unit names would
    # collide with this one's labels).
    local u
    for u in $(copy_units); do systemctl stop "$u" 2> /dev/null || true; systemctl reset-failed "$u" 2> /dev/null || true; done
  fi
  # On a resume the phase stays what it was; a final copy that was already
  # done is still valid until the source is written to again (thaw-disk
  # demotes it).
  # A final copy is only good while the source cannot have changed since: if the
  # data directory is writable again (thawed, or the host rebooted), it is
  # stale, so demote it as thaw-disk does.
  if [ -n "$resumed" ]; then
    if [ "$phase" = copied ]; then
      case ",$(data_mount OPTIONS)," in *,ro,*) ;; *) phase=prepared ;; esac
    fi
    state_write "$cur" "$new" "$phase"
  else
    state_write "$cur" "$new" prepared
  fi
  echo "prepared=yes"
  echo "device=$dev"
  echo "staging=$NEW_MNT"
}

# copy / copy-status
##########################################################

# unit_report <label>: the state of a pass and its timing, as key=value.
unit_report() {
  local unit=${UNIT_PREFIX}$1.service st start_us exit_us now dur="" age="" used=""
  st=$(unit_state "$unit")
  echo "unit=$unit"
  echo "state=$st"
  if [ "$st" != none ]; then
    start_us=$(sd "$unit" ExecMainStartTimestampMonotonic)
    exit_us=$(sd "$unit" ExecMainExitTimestampMonotonic)
    now=$(now_mono)
    echo "exit_code=$(sd "$unit" ExecMainStatus)"
    echo "started=$(sd "$unit" ExecMainStartTimestamp)"
    if [ "$st" = running ]; then
      [ "${start_us:-0}" -gt 0 ] && dur=$((now - start_us / 1000000))
    else
      echo "ended=$(sd "$unit" ExecMainExitTimestamp)"
      if [ "${start_us:-0}" -gt 0 ] && [ "${exit_us:-0}" -gt 0 ]; then
        dur=$(((exit_us - start_us) / 1000000))
        age=$((now - exit_us / 1000000))
      fi
    fi
    echo "duration_s=$dur"
    echo "age_s=$age"
  fi
  set_dest
  if is_move; then
    # (a failed ssh just leaves the number out)
    used=$(tssh "df -B1 --output=used $DATA | tail -n 1 | tr -d ' '" 2> /dev/null < /dev/null || true)
    [ -z "$used" ] || echo "new_used_bytes=$used"
  elif mountpoint -q "$NEW_MNT"; then echo "new_used_bytes=$(df -B1 --output=used "$NEW_MNT" | tail -n 1 | tr -d ' ')"; fi
}

cmd_copy() {
  local label=${1:-} unit st other
  [[ "$label" =~ ^[a-z0-9]+$ ]] || die "pass label must be lowercase letters and digits"
  unit=${UNIT_PREFIX}$label.service
  set_dest
  precondition "phase is '$(state_get phase)', not prepared (see $STATE)" [ "$(state_get phase)" = prepared ]
  if is_move; then
    precondition "$MOVE_KEY is missing: run move prepare first" [ -f "$MOVE_KEY" ]
  else
    precondition "$NEW_MNT is not mounted: run prepare first" mountpoint -q "$NEW_MNT"
  fi
  precondition "rsync is not installed" have rsync
  st=$(unit_state "$unit")
  if [ "$st" = running ] || [ "$st" = ok ]; then unit_report "$label"; return 0; fi
  for other in $(copy_units); do
    [ "$other" = "$unit" ] || [ "$(unit_state "$other")" != running ] || die "$other is still running"
  done
  if [ -n "$DRY_RUN" ]; then
    plan "systemd-run --unit=${unit%.service} --remain-after-exit --property=Nice=10 ionice -c 3 rsync (exit 24 counts as success) ${RSYNC_OPTS[*]} --stats ${RSYNC_EXCLUDES[*]}${XFER_SSH:+ -e '$XFER_SSH' --rsync-path='$XFER_RSYNC'} $DATA/ $COPY_DEST"
    return 0
  fi
  xfer_opts
  # A failed pass is retried by calling copy again with the same label.
  [ "$st" != failed ] || systemctl reset-failed "$unit"
  # A transient unit, so the copy survives the operator's ssh session (and
  # laptop) going away; the pass is observed with copy-status. systemd 219
  # (Amazon Linux 2) lets systemd-run set only a few properties, so:
  #  - --remain-after-exit keeps the finished unit around, with its exit status
  #    and timestamps, for copy-status. Without it systemd forgets a unit the
  #    moment it succeeds.
  #  - Nice=10 and ionice -c 3 (idle) keep it behind the app, as far as the
  #    kernel's I/O scheduler honours that (NVMe devices usually have none, so
  #    this mostly protects the CPU).
  #  - The shell wrapper turns rsync's exit 24 (files vanished between the scan
  #    and the transfer) into success: on a live source that is routine (temp
  #    files, deleted blogs) and the next pass picks up the difference. The
  #    frozen pass (final-copy) has no such excuse.
  systemd-run --unit="${unit%.service}" \
    --description="Blot data volume copy ($label)" \
    --remain-after-exit --property=Nice=10 \
    ionice -c 3 bash -c 'rsync "$@"; rc=$?; [ "$rc" = 24 ] && rc=0; exit $rc' _ \
    "${RSYNC_OPTS[@]}" --stats "${RSYNC_EXCLUDES[@]}" ${XFER[@]+"${XFER[@]}"} "$DATA/" "$COPY_DEST" > /dev/null
  unit_report "$label"
}

cmd_copy_status() { [[ "${1:-}" =~ ^[a-z0-9]+$ ]] || die "pass label must be lowercase letters and digits"; unit_report "$1"; }

# final-copy
##########################################################

# The frozen pass: the old volume is read-only, so the file list cannot change
# under us and nothing can vanish (exit 24 is an error here). Its duration is
# the app's read-only window, and rsync's walk of millions of files is
# dominated by metadata round trips, so it is split into shards that run in
# parallel. Every path must be covered exactly once, and --delete must still
# be right at every level:
#
#   A. one rsync of the top level, with the contents of each shard parent
#      (static/, blogs/, git/) excluded. It copies everything else in full,
#      the shard parents themselves as empty directories, and (excluded paths
#      being protected from deletion) leaves what the other steps handle alone.
#   B. per shard parent, a non-recursive pass (-d, no -r): it copies that
#      directory's own files and symlinks, creates or updates each child
#      directory without descending, and --delete removes children that are
#      gone from the source (a deleted blog) together with everything below.
#   C. one rsync per child directory of each shard parent, in parallel
#      (xargs -P), recursing with --delete so stale files inside it go too.
#
# A path under static/<id>/ is therefore only visited by C for that <id>; a
# file directly in static/ only by B; the rest of the tree only by A. Hard
# links between two different children are copied as separate files if they
# change in this pass (-H only sees one shard); unchanged ones keep the links
# the single-rsync live passes made.
cmd_final_copy() {
  local budget=${1:-0} ex p shards=0 start rc=0 wd="" i_old n_used n_inodes
  set_dest
  precondition "rsync is not installed" have rsync
  precondition "phase is '$(state_get phase)', not prepared" phase_in prepared copied
  if is_move; then
    precondition "$MOVE_KEY is missing: run move prepare first" [ -f "$MOVE_KEY" ]
    precondition "FINAL_COPY_JOBS is $FINAL_COPY_JOBS: it must stay below 10, sshd's default MaxSessions, since all the rsyncs share one ssh connection" [ "$FINAL_COPY_JOBS" -lt 10 ]
  else
    precondition "$NEW_MNT is not mounted: run prepare first" mountpoint -q "$NEW_MNT"
  fi
  case ",$(data_mount OPTIONS)," in
    *,ro,*) ;;
    *) if [ -n "$DRY_RUN" ]; then echo "note: $DATA is not read-only (it will be by then)" >&2; else die "$DATA is not read-only: freeze-disk first"; fi ;;
  esac
  for p in $(copy_units); do [ "$(unit_state "$p")" != running ] || die "$p is still running"; done

  ex=("${RSYNC_EXCLUDES[@]}")
  for p in $SHARD_PARENTS; do ex+=("--exclude=/$p/*"); done
  if [ -n "$DRY_RUN" ]; then
    for p in $SHARD_PARENTS; do
      [ -d "$DATA/$p" ] && shards=$((shards + $(find "$DATA/$p" -mindepth 1 -maxdepth 1 -type d | wc -l)))
    done
    if is_move; then plan "open one ssh connection to $XFER_HOST (ssh -M -N -f -S) for every rsync below to reuse, and close it at the end"; fi
    plan "rsync ${RSYNC_OPTS[*]} ${ex[*]}${XFER_SSH:+ -e '$XFER_SSH -S <connection>' --rsync-path='$XFER_RSYNC'} $DATA/ $COPY_DEST"
    plan "per shard parent ($SHARD_PARENTS): rsync -dlptgoD -AXS --numeric-ids --delete"
    plan "$shards rsyncs of the child directories, $FINAL_COPY_JOBS at a time, then sync; phase=copied"
    return 0
  fi
  take_lock
  work=$(mktemp -d /tmp/blot-final-copy.XXXXXX)
  # close_master first: stop_rsyncs calls set_dest, which drops the -S from XFER_SSH.
  trap 'close_master; stop_rsyncs; rm -rf "$work"' EXIT
  trap 'exit 143' INT TERM HUP
  if is_move; then
    # One connection for the whole frozen pass: each rsync would otherwise pay a
    # handshake inside the freeze, and sshd rate-limits new connections. Live
    # passes do not use this: they must outlive it.
    # It runs on after this command, so it must not keep the lock (fd 9) or this
    # script's stdout, which the operator's ssh session waits on.
    $XFER_SSH -M -N -f -S "$work/ctl" "$XFER_HOST" < /dev/null > /dev/null 2> "$work/master" 9>&- ||
      { cat "$work/master" >&2; die "cannot open an ssh connection to $XFER_HOST"; }
    XFER_SSH="$XFER_SSH -S $work/ctl"
    export XFER_SSH
  fi
  xfer_opts
  start=$(date +%s)
  # A budget lets the caller keep the copy inside the read-only freeze's TTL.
  if [ "$budget" -gt 0 ]; then
    # A sleep that was killed (below) means the copy finished in time
    ( sleep "$budget" || exit 0; echo "error: the final copy ran past its ${budget}s budget; stopping it" >&2; touch "$work/over"; stop_rsyncs ) &
    wd=$!
  fi

  rsync "${RSYNC_OPTS[@]}" "${ex[@]}" ${XFER[@]+"${XFER[@]}"} "$DATA/" "$COPY_DEST" || rc=$?
  if [ "$rc" = 0 ]; then
    for p in $SHARD_PARENTS; do
      [ -d "$DATA/$p" ] || continue
      rsync -dlptgoD -HAXS --numeric-ids --delete ${XFER[@]+"${XFER[@]}"} "$DATA/$p/" "$COPY_DEST$p/" || { rc=$?; break; }
      find "$DATA/$p" -mindepth 1 -maxdepth 1 -type d -printf "$p/%f\\0" >> "$work/list"
    done
  fi
  if [ "$rc" = 0 ] && [ -s "$work/list" ]; then
    shards=$(tr -cd '\0' < "$work/list" | wc -c)
    export DATA work
    export -f shard_copy xfer_opts
    # xargs keeps going when one shard fails and exits 123; each failure is
    # recorded in $work/failed so the summary can name it.
    xargs -0 -n 1 -P "$FINAL_COPY_JOBS" -a "$work/list" bash -c 'shard_copy "$1"' _ || rc=$?
  fi
  if [ -n "$wd" ]; then
    # The watchdog goes before its sleep. The other way round it sees the
    # sleep killed, prints "Terminated" and could go on to flag the copy as
    # over budget before it is killed itself.
    local sleeper
    sleeper=$(pgrep -P "$wd" || true)
    kill "$wd" 2> /dev/null || true
    wait "$wd" 2> /dev/null || true
    [ -z "$sleeper" ] || kill $sleeper 2> /dev/null || true
  fi
  if [ -e "$work/over" ]; then die "over the ${budget}s budget"; fi
  if [ -s "$work/failed" ]; then echo "failed shards:" >&2; cat "$work/failed" >&2; fi
  [ "$rc" = 0 ] || die "the final copy failed (rsync exit $rc)"
  sync
  # The new numbers come from the target, over the same connection.
  if is_move; then
    tssh sync < /dev/null || die "could not sync the target's disk"
    n_used=$(tssh "df -B1 --output=used $DATA | tail -n 1 | tr -d ' '" < /dev/null)
    n_inodes=$(tssh "df --output=iused $DATA | tail -n 1 | tr -d ' '" < /dev/null)
  else
    n_used=$(df -B1 --output=used "$NEW_MNT" | tail -n 1 | tr -d ' ')
    n_inodes=$(df --output=iused "$NEW_MNT" | tail -n 1 | tr -d ' ')
  fi
  set_phase copied
  i_old=$(df --output=iused "$DATA" | tail -n 1 | tr -d ' ')
  echo "final_copy=ok"
  echo "shards=$shards"
  echo "duration_s=$(($(date +%s) - start))"
  echo "new_used_bytes=$n_used"
  echo "inodes_old=$i_old"
  echo "inodes_new=$n_inodes"
}

# close_master: end the frozen pass's shared ssh connection (a move only).
close_master() {
  [ -z "$work" ] || [ ! -S "$work/ctl" ] || $XFER_SSH -O exit "$XFER_HOST" > /dev/null 2>&1 || true
}

# shard_copy <path relative to the data directory>: one child directory.
# Exported for xargs; it recreates the path under the same parent on the target.
shard_copy() {
  local rc=0
  xfer_opts
  rsync -aHAXS --numeric-ids --delete ${XFER[@]+"${XFER[@]}"} "$DATA/$1" "$COPY_DEST${1%/*}/" || rc=$?
  [ "$rc" = 0 ] || { echo "$1 (rsync exit $rc)" >> "$work/failed"; return "$rc"; }
}

# freeze-disk / thaw-disk
##########################################################

# A read-only remount applies to the whole filesystem, so the containers'
# bind mounts of it turn read-only too. It fails with EBUSY while any process
# holds a file on it open for writing: that is the proof that nothing is
# still writing, which the freeze in the app alone (it only gates new
# requests) cannot give. A failure is retried until the time is up; the
# error is not distinguished from EBUSY, a different one just takes longer to
# report.
cmd_freeze_disk() {
  local secs=${1:-30} i err=""
  [[ "$secs" =~ ^[0-9]+$ ]] || die "usage: freeze-disk <seconds>"
  if [ -n "$DRY_RUN" ]; then plan "mount -o remount,ro $DATA, retrying every second for up to ${secs}s"; return 0; fi
  for ((i = 0; i <= secs; i++)); do
    if err=$(mount -o remount,ro "$DATA" 2>&1); then
      echo "frozen=yes"
      echo "waited_s=$i"
      return 0
    fi
    sleep 1
  done
  echo "$DATA would not go read-only in ${secs}s: $err" >&2
  echo "Open for writing (lsof):" >&2
  if command -v lsof > /dev/null; then
    lsof +f -- "$DATA" 2> /dev/null | awk 'NR == 1 || $4 ~ /[wu]$/' | head -n 40 >&2 || true
  else
    echo "lsof is not installed" >&2
  fi
  exit 1
}

# The rollback. The old volume is the only one ever mounted read-only, and
# after a swap the top mount is the new, writable one, so this is harmless
# then. A final copy made before this is stale once the source is writable
# again, so the phase goes back to prepared.
cmd_thaw_disk() {
  if [ -n "$DRY_RUN" ]; then plan "mount -o remount,rw $DATA"; return 0; fi
  mount -o remount,rw "$DATA"
  [ "$(state_get phase)" != copied ] || set_phase prepared
  echo "frozen=no"
}

# swap
##########################################################

cmd_swap() {
  local old new dev_new got c pid bad="" containers_list
  shrink_only swap
  old=$(state_get old_volume); new=$(state_get new_volume)
  precondition "phase is '$(state_get phase)', not copied: run final-copy first" phase_in copied
  precondition "$ID_FILE says $(current_volume), the resize started from $old" [ "$(current_volume)" = "$old" ]
  precondition "$NEW_MNT is not mounted" mountpoint -q "$NEW_MNT"
  precondition "$NEW_MNT/$MARKER does not say $new" [ "$(read_marker "$NEW_MNT")" = "$new" ]
  case ",$(data_mount OPTIONS)," in
    *,ro,*) ;;
    *) if [ -n "$DRY_RUN" ]; then echo "note: $DATA is not read-only (it will be by then)" >&2; else die "$DATA is not read-only: refusing to swap while the old volume can still change"; fi ;;
  esac
  containers_list=$(containers)
  if [ -n "$DRY_RUN" ]; then
    [ -n "$new" ] || new="<the new volume>"
    plan "write $new to $ID_FILE (previous kept in $ID_FILE.previous)"
    plan "mount --move $NEW_MNT $DATA; mount --make-shared $DATA"
    plan "check $MARKER says $new on the host and in: $(echo "$containers_list" | tr '\n' ' ')"
    plan "on any mismatch: umount $DATA, restore $ID_FILE, phase=prepared"
    return 0
  fi
  take_lock
  dev_new=$(readlink -f "$(volume_link "$new")")

  # undo: put the old volume back in front. It was only ever mounted
  # underneath, still read-only, so the caller thaws it afterwards. Lazy
  # unmount is the fallback: a process that opened a file on the new volume in
  # the last few seconds would make a plain umount fail with EBUSY.
  # swap_open is set from the moment the ID file is changed; moved, once the
  # new volume is mounted over the data directory (undoing before that must not
  # unmount the old volume). The EXIT trap below runs undo on ANY failure in
  # between (a failed command under set -e, die, a signal); explicit undo calls
  # clear swap_open first, so it never runs twice.
  swap_open=""; moved=""
  undo() {
    set +e
    swap_open=""
    if [ -n "$moved" ]; then
      umount "$DATA" 2> /dev/null || umount -l "$DATA" || echo "WARNING: could not unmount the new volume from $DATA" >&2
      moved=""
    fi
    cp -p "$ID_FILE.previous" "$ID_FILE"
    set_phase prepared
    echo "swap=undone"
    echo "restored=$(read_marker "$DATA")"
    echo "after the undo the new volume is unmounted; prepare mounts it again" >&2
  }
  trap 'rc=$?; if [ -n "$swap_open" ]; then echo "error: the swap failed (exit $rc); putting the old volume back" >&2; undo; fi; exit $rc' EXIT
  trap 'exit 143' INT TERM HUP

  cp -p "$ID_FILE" "$ID_FILE.previous"
  swap_open=1
  printf '%s\n' "$new" > "$ID_FILE.tmp"
  mv "$ID_FILE.tmp" "$ID_FILE"
  mount --move "$NEW_MNT" "$DATA" || die "mount --move failed; nothing changed"
  moved=1
  # The next swap needs the top mount to be shared, as mount-data-volume.sh
  # leaves it at boot: the move does not carry that over.
  mount --make-shared "$DATA"

  got=$(read_marker "$DATA")
  echo "host=$got"
  if [ "$got" != "$new" ] || [ "$(data_device)" != "$dev_new" ]; then
    undo
    die "the host sees '$got' at $DATA (device $(data_device)), expected $new on $dev_new"
  fi
  for c in $containers_list; do
    # nsenter, not docker exec: it also works on a paused container (a drill
    # pauses them) and does not depend on the container's processes. -r sets
    # the root to the container's, so the path resolves inside it, not on the host.
    pid=$(docker inspect -f '{{.State.Pid}}' "$c" 2> /dev/null || true)
    got=$(timeout 20 nsenter -t "$pid" -m -r cat "$CONTAINER_DATA/$MARKER" 2> /dev/null | tr -d '[:space:]' || true)
    echo "container.$c=${got:-unreadable}"
    [ "$got" = "$new" ] || bad="$bad $c"
  done
  if [ -n "$bad" ]; then
    # A split view (some containers on the new volume, some on the old) is
    # worse than either; go back.
    undo
    die "these containers do not see the new volume:$bad"
  fi
  set_phase swapped
  swap_open=""
  echo "swap=ok"
  echo "new_volume=$new"
}

# stop-copy
##########################################################

cmd_stop_copy() {
  if [ -n "$DRY_RUN" ]; then plan "stop $UNIT_PREFIX* units and any rsync writing to $NEW_MNT"; return 0; fi
  local u
  for u in $(copy_units); do systemctl stop "$u" 2> /dev/null || true; done
  stop_rsyncs
  echo "stopped=yes"
}

# Moving to another host
##########################################################

# The swap, release-old and old-volume-status belong to a shrink on one host. A
# move leaves the source's mount alone and the target mounts its own volume at
# boot (mount-data-volume.service), so there is nothing to swap.
shrink_only() {
  precondition "this host's state file is for a move to $(state_get target), not a shrink: $1 is only for a shrink" [ -z "$(state_get target)" ]
}

# adopt <new-volume-id> [old-volume-id]: run on the NEW host. A volume made from
# a snapshot of the source carries the source's ID in .blot-data-volume, and
# mount-data-volume.sh refuses a volume whose marker is not its own ID. This
# mounts it at a staging directory, writes the right ID and unmounts it. It
# never formats: the filesystem must already be XFS with a marker that names
# the new volume (done) or the old one (the snapshot's).
cmd_adopt() {
  local new=${1:-} old=${2:-} link dev no others fstype marker i mnt=$STAGING/adopt
  valid_volume "$new"
  [ -z "$old" ] || valid_volume "$old"
  link=$(volume_link "$new")
  if [ -n "$DRY_RUN" ]; then
    if [ -e "$link" ]; then echo "device=$(readlink -f "$link")"; else echo "device=absent"; fi
    plan "wait up to 120s for $link; refuse if it is mounted anywhere (unless already at $DATA with the right marker)"
    plan "refuse anything but XFS (this never runs mkfs); mount -o noatime it at $mnt"
    plan "check $MARKER says the old volume's ID or $new, write $new to it, unmount"
    return 0
  fi
  take_lock
  for ((i = 0; i < 120; i++)); do
    [ -e "$link" ] && break
    sleep 1
  done
  [ -e "$link" ] || die "$link did not appear within 120s: is $new attached to this instance?"
  dev=$(readlink -f "$link")
  no=$(devno "$dev")
  others=$(mounts_of "$no" | grep -vx "$mnt" || true)
  if [ "$others" = "$DATA" ] && [ "$(read_marker "$DATA")" = "$new" ]; then
    echo "adopted=yes"
    echo "note=already mounted at $DATA with the right marker"
    return 0
  fi
  [ -z "$others" ] || die "$new ($dev) is mounted at: $(echo "$others" | tr '\n' ' ')"
  fstype=$(blkid -p -o value -s TYPE "$dev" 2> /dev/null || true)
  [ "$fstype" = xfs ] || die "$dev has ${fstype:-no} filesystem, not XFS: adopt only takes a volume made from a snapshot of the data volume, and never formats"

  mkdir -p "$STAGING"
  mountpoint -q "$STAGING" || mount --bind "$STAGING" "$STAGING"
  mount --make-private "$STAGING"
  mkdir -p "$mnt"
  mountpoint -q "$mnt" || mount -o noatime "$dev" "$mnt"
  trap 'umount "$mnt" 2> /dev/null || true' EXIT
  marker=$(read_marker "$mnt")
  if [ "$marker" != "$new" ] && { [ -z "$old" ] || [ "$marker" != "$old" ]; }; then
    die "$dev's $MARKER says '$marker', expected $new${old:+ or $old}; refusing to adopt it"
  fi
  echo "$new" > "$mnt/$MARKER"
  sync
  umount "$mnt"
  trap - EXIT
  echo "adopted=yes"
  echo "device=$dev"
}

# prewarm <volume-id>: run on the NEW host. Reads the whole device once, in the
# background, at a low priority. A volume made from a snapshot loads its blocks
# from S3 the first time they are read; the switch must not be the first read.
cmd_prewarm() {
  local new=${1:-} link dev st
  valid_volume "$new"
  link=$(volume_link "$new")
  if [ -n "$DRY_RUN" ]; then
    plan "systemd-run --unit=$PREWARM_UNIT --remain-after-exit --property=Nice=10 dd if=<$link> of=/dev/null bs=1M"
    return 0
  fi
  [ -e "$link" ] || die "$link is absent: is $new attached to this instance?"
  dev=$(readlink -f "$link")
  st=$(unit_state "$PREWARM_UNIT.service")
  if [ "$st" = running ] || [ "$st" = ok ]; then
    # One for another device (an earlier move) is forgotten.
    if [ "$(sd "$PREWARM_UNIT.service" Description)" = "Blot data volume pre-warm of $dev" ]; then prewarm_report; return 0; fi
    systemctl stop "$PREWARM_UNIT.service" 2> /dev/null || true
  fi
  [ "$st" = none ] || systemctl reset-failed "$PREWARM_UNIT.service" 2> /dev/null || true
  systemd-run --unit="$PREWARM_UNIT" \
    --description="Blot data volume pre-warm of $dev" \
    --remain-after-exit --property=Nice=10 \
    dd if="$dev" of=/dev/null bs=1M > /dev/null 2>&1
  prewarm_report
}

# authorize-key <source-private-ip> <key-type> <key>: run on the NEW host. Lets
# the source's move key in as ec2-user, from that address only and for nothing
# but a command (no forwarding), marked with a comment so deauthorize-key can
# find it. Replaces an earlier line of ours, so it is safe to repeat.
cmd_authorize_key() {
  local ip=${1:-} type=${2:-} key=${3:-} home file line tmp
  is_ip "$ip" || die "usage: authorize-key <source-private-ip> ssh-ed25519 <key>"
  [ "$type" = ssh-ed25519 ] && [[ "$key" =~ ^[A-Za-z0-9+/=]+$ ]] || die "usage: authorize-key <source-private-ip> ssh-ed25519 <key>"
  home=$(getent passwd ec2-user | cut -d: -f6)
  [ -n "$home" ] || die "no ec2-user on this host"
  file=$home/.ssh/authorized_keys
  line="from=\"$ip\",no-agent-forwarding,no-X11-forwarding,no-port-forwarding $type $key $MOVE_KEY_COMMENT"
  if [ -n "$DRY_RUN" ]; then plan "replace any '$MOVE_KEY_COMMENT' line in $file with the source's key, from $ip only"; return 0; fi
  install -d -m 700 -o ec2-user -g ec2-user "$home/.ssh"
  touch "$file"
  tmp=$(mktemp)
  { grep -v " $MOVE_KEY_COMMENT\$" "$file" || true; } > "$tmp"
  echo "$line" >> "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
  chown ec2-user:ec2-user "$file"
  chmod 600 "$file"
  echo "authorized=yes"
}

cmd_deauthorize_key() {
  local home file tmp
  home=$(getent passwd ec2-user | cut -d: -f6)
  file=$home/.ssh/authorized_keys
  if [ -n "$DRY_RUN" ]; then plan "remove the '$MOVE_KEY_COMMENT' line from $file"; return 0; fi
  if [ -f "$file" ]; then
    tmp=$(mktemp)
    { grep -v " $MOVE_KEY_COMMENT\$" "$file" || true; } > "$tmp"
    cat "$tmp" > "$file"
    rm -f "$tmp"
  fi
  echo "deauthorized=yes"
}

# move-prepare <target-private-ip> <ssh-port> <new-volume-id> <target-host-key> [existing]:
# run on the SOURCE. Makes the key the copy uses to reach the target (the hosts
# have no key for each other, and root login is off), records the target's host
# key (the base64 of its ed25519 key, read by resize.sh over its own ssh), and
# writes the state file: phase=prepared, the volume the data is going to and
# where. `existing` says the target already had its volume (a move back), so
# nothing was made or needs warming.
cmd_move_prepare() {
  local ip=${1:-} port=${2:-} new=${3:-} hostkey=${4:-} existing=${5:-} cur phase resumed="" u keyed
  is_ip "$ip" || die "usage: move-prepare <target-private-ip> <ssh-port> <new-volume-id> <target-host-key> [existing]"
  [[ "$port" =~ ^[0-9]+$ ]] || die "the ssh port must be a number"
  valid_volume "$new"
  [[ "$hostkey" =~ ^[A-Za-z0-9+/=]+$ ]] || die "the target's host key must be the base64 part of its ssh-ed25519 key"
  [ -z "$existing" ] || [ "$existing" = existing ] || die "the fifth argument is 'existing' or nothing"
  cur=$(current_volume)
  [ "$new" != "$cur" ] || die "$new is the current data volume"
  phase=$(state_get phase)
  case "$phase" in
    prepared | copied)
      is_move || die "a resize to $(state_get new_volume) is in progress (state file $STATE)"
      [ "$(state_get new_volume)" = "$new" ] || die "a move to $(state_get new_volume) is already in progress (state file $STATE)"
      [ "$(state_get old_volume)" = "$cur" ] || die "$STATE says the old volume is $(state_get old_volume), the current one is $cur"
      resumed=1 ;;
    swapped) die "a shrink swapped and was not finished (state file $STATE): run resize.sh finish first" ;;
  esac
  if [ -n "$DRY_RUN" ]; then
    plan "ssh-keygen -t ed25519 -N '' -C $MOVE_KEY_COMMENT $MOVE_KEY (kept if it exists)"
    plan "write the target's host key for [$ip]:$port to $MOVE_KNOWN_HOSTS"
    plan "record old=$cur new=$new target=ec2-user@$ip:$port${existing:+ existing=yes} phase=prepared in $STATE"
    return 0
  fi
  take_lock
  have ssh-keygen || die "ssh-keygen is not installed"
  mkdir -p "$(dirname "$MOVE_KEY")"
  if [ ! -f "$MOVE_KEY" ]; then
    rm -f "$MOVE_KEY.pub"
    ssh-keygen -q -t ed25519 -N '' -C "$MOVE_KEY_COMMENT" -f "$MOVE_KEY"
  fi
  chmod 600 "$MOVE_KEY"
  if [ "$port" = 22 ]; then keyed=$ip; else keyed="[$ip]:$port"; fi
  echo "$keyed ssh-ed25519 $hostkey" > "$MOVE_KNOWN_HOSTS.tmp"
  chmod 600 "$MOVE_KNOWN_HOSTS.tmp"
  mv "$MOVE_KNOWN_HOSTS.tmp" "$MOVE_KNOWN_HOSTS"

  if [ -z "$resumed" ]; then
    # A fresh move: forget passes of an earlier one (their labels would collide).
    for u in $(copy_units); do systemctl stop "$u" 2> /dev/null || true; systemctl reset-failed "$u" 2> /dev/null || true; done
    state_write "$cur" "$new" prepared "ec2-user@$ip:$port" "${existing:+yes}"
  else
    # As prepare does: a final copy is only good while the source is still read-only.
    if [ "$phase" = copied ]; then
      case ",$(data_mount OPTIONS)," in *,ro,*) ;; *) phase=prepared ;; esac
    fi
    state_write "$cur" "$new" "$phase" "ec2-user@$ip:$port" "${existing:+yes}"
  fi
  echo "prepared=yes"
  echo "public_key=$(cat "$MOVE_KEY.pub" 2> /dev/null || ssh-keygen -y -f "$MOVE_KEY")"
}

# move-status: run on the SOURCE. The state of a move and what the target says
# when this host reaches it with its move key.
cmd_move_status() {
  local err out
  echo "phase=$(state_get phase)"
  echo "old_volume=$(state_get old_volume)"
  echo "new_volume=$(state_get new_volume)"
  echo "target=$(state_get target)"
  echo "existing=$(state_get existing)"
  if ! is_move; then echo "move=no"; return 0; fi
  echo "move=yes"
  if [ ! -f "$MOVE_KEY" ]; then echo "ssh=nokey"; return 0; fi
  set_dest
  if err=$(tssh true 2>&1 < /dev/null); then
    echo "ssh=ok"
  else
    echo "ssh=failed"
    echo "ssh_error=$(echo "$err" | tail -n 1)"
    return 0
  fi
  # facts runs as root there, so it also proves passwordless sudo.
  if out=$(on_target facts 2> /dev/null); then
    echo "sudo=ok"
    echo "$out" | sed 's/^/target_/'
  else
    echo "sudo=failed"
  fi
  if tssh 'sudo -n rsync --version > /dev/null 2>&1' < /dev/null; then echo "rsync=ok"; else echo "rsync=failed"; fi
}

# move-done: run on the SOURCE after the switch (resize.sh move retag). Takes
# the key out of the target's authorized_keys, deletes it and the known-hosts
# file here, and sets phase=moved. The source's own mount is not touched: the
# old host is the rollback until the cycle's finish.
cmd_move_done() {
  precondition "this host has no move recorded" is_move
  precondition "phase is '$(state_get phase)', not copied or moved" phase_in copied moved
  if [ -n "$DRY_RUN" ]; then
    plan "remove the '$MOVE_KEY_COMMENT' line from ec2-user's authorized_keys on $(state_get target)"
    plan "delete $MOVE_KEY, $MOVE_KEY.pub and $MOVE_KNOWN_HOSTS; set phase=moved in $STATE"
    return 0
  fi
  if [ -f "$MOVE_KEY" ]; then
    on_target deauthorize-key < /dev/null > /dev/null 2>&1 ||
      echo "WARNING: could not reach $(state_get target) to remove the key; delete the '$MOVE_KEY_COMMENT' line from ec2-user's authorized_keys there by hand" >&2
  fi
  rm -f "$MOVE_KEY" "$MOVE_KEY.pub" "$MOVE_KNOWN_HOSTS"
  set_phase moved
  echo "moved=yes"
}

# old-volume-status
##########################################################

# After a swap the old volume stays mounted, stacked under the new one on the
# host and in every container, until the containers are recreated (and, with
# release-old, the host's own copy is unmounted by hand). It can be detached
# once no mount namespace has it. A mount of a volume in a container's own
# namespace does not show up in the host's /proc/self/mountinfo, hence the
# scan of every process, grouped by mount namespace.
cmd_old_volume_status() {
  local id=${1:-} link dev m
  valid_volume "$id"
  echo "current=$([ "$(current_volume)" = "$id" ] && echo yes || echo no)"
  link=$(volume_link "$id")
  if [ ! -e "$link" ]; then
    echo "device=absent"
    echo "mounted=no"
    echo "mounted_host=no"
    echo "mounted_elsewhere=0"
    return 0
  fi
  dev=$(readlink -f "$link")
  echo "device=$dev"
  m=$(mounts_of "$(devno "$dev")")
  if [ -n "$m" ]; then echo "mounted=yes"; else echo "mounted=no"; fi
  for dev in $m; do echo "mount=$dev"; done
  scan_mounts "$(devno "$(readlink -f "$link")")"
  echo "mounted_host=$M_HOST"
  echo "mounted_elsewhere=$([ -z "$M_OTHERS" ] && echo 0 || echo "$M_OTHERS" | wc -l | tr -d ' ')"
  [ -z "$M_OTHERS" ] || echo "$M_OTHERS"
  echo "mounted_following=$([ -z "$M_FOLLOWERS" ] && echo 0 || echo "$M_FOLLOWERS" | wc -l | tr -d ' ')"
  [ -z "$M_FOLLOWERS" ] || echo "$M_FOLLOWERS"
}

# release-old
##########################################################

# After a swap the host's own mount namespace has two mounts at the data
# directory: the new volume on top of the old one. Unmounting both and
# mounting the current volume again leaves one, and frees the old device on
# the host with no reboot. The containers are not affected: each has its own
# copy of the mounts (rslave), and unmounting on the host does not reach a
# mount a container is using. What they lose is the link to the host's new
# mount, so a later swap would not reach them until an app deploy recreates
# them; swap checks every container's marker and puts the old volume back if
# one does not follow, so that is safe. Only for an old volume that no
# container's namespace holds any more (the deploys recreated them all).
#
# The data directory is an empty directory for a moment between the second
# umount and the mount, and shows the old, read-only volume between the first
# and the second. Nothing else is done in between, and the signals that would
# stop the script there are ignored.
cmd_release_old() {
  local old=${1:-} cur link dev_old no_old u c pid got bad="" err
  valid_volume "$old"
  shrink_only release-old
  cur=$(current_volume)
  link=$(volume_link "$old")

  [ "$(readlink /proc/self/ns/mnt)" = "$(readlink /proc/1/ns/mnt)" ] || die "this is not the host's mount namespace"
  precondition "$ID_FILE names '$cur', which is not a volume ID" is_volume_id "$cur"
  precondition "$old is the current data volume ($ID_FILE)" [ "$old" != "$cur" ]
  [ -e "$link" ] || die "$link is absent: $old is not attached to this host, nothing to release"
  dev_old=$(readlink -f "$link")
  no_old=$(devno "$dev_old")
  scan_mounts "$no_old"
  if [ "$M_HOST" = no ] && [ -z "$M_OTHERS" ]; then die "$old ($dev_old) is not mounted anywhere: nothing to release"; fi
  precondition "$old is mounted in the host's namespace" [ "$M_HOST" = yes ]
  precondition "$old is still mounted in other mount namespaces (containers that were not recreated):
$M_OTHERS
Deploy the app, then try again" [ -z "$M_OTHERS" ]
  precondition "$(data_mount_count) mounts at $DATA in the host's namespace, expected 2 (the new volume on top of the old one)" [ "$(data_mount_count)" = 2 ]
  precondition "$(read_marker "$DATA") is on top at $DATA, expected the current volume $cur" [ "$(read_marker "$DATA")" = "$cur" ]
  precondition "the volume mounted at $DATA is '$(mounted_volume)', not $cur" [ "$(mounted_volume)" = "$cur" ]
  precondition "$MOUNT_SCRIPT is missing or not executable (config/host/deploy.sh installs it)" [ -x "$MOUNT_SCRIPT" ]
  for u in $(copy_units); do
    precondition "$u is still running" [ "$(unit_state "$u")" != running ]
  done
  if [ -n "$DRY_RUN" ]; then
    plan "umount $DATA (the new volume $cur; containers keep their own copies); check $MARKER says $old and one mount is left"
    plan "umount $DATA (the old volume $old); check nothing is mounted there"
    plan "$MOUNT_SCRIPT (mounts $cur by ID, checks its marker, makes it shared)"
    plan "check one mount at $DATA, marker $cur, propagation shared, and the same marker in: $(containers | tr '\n' ' ')"
    plan "set phase=released in $STATE if its old_volume is $old"
    return 0
  fi
  take_lock

  trap '' HUP INT TERM
  if ! err=$(umount "$DATA" 2>&1); then
    trap - HUP INT TERM
    echo "could not unmount $DATA: $err" >&2
    echo "Open on it (lsof):" >&2
    if command -v lsof > /dev/null; then
      lsof +f -- "$DATA" 2> /dev/null | head -n 40 >&2 || true
    else
      echo "lsof is not installed" >&2
    fi
    die "nothing was changed"
  fi
  got=$(read_marker "$DATA")
  if [ "$got" != "$old" ] || [ "$(data_mount_count)" != 1 ]; then
    trap - HUP INT TERM
    die "after the first umount, $DATA shows marker '$got' with $(data_mount_count) mount(s) (device $(data_device)); expected the old volume $old ($dev_old) as the only mount. Not touching anything else. Inspect with: findmnt --target $DATA; grep ' $DATA ' /proc/self/mountinfo; cat $DATA/$MARKER"
  fi
  # The one place the containers could be affected if unmounts did reach them.
  for c in $(containers); do
    pid=$(docker inspect -f '{{.State.Pid}}' "$c" 2> /dev/null || true)
    got=$(timeout 20 nsenter -t "$pid" -m -r cat "$CONTAINER_DATA/$MARKER" 2> /dev/null | tr -d '[:space:]' || true)
    echo "container.$c=${got:-unreadable}" >&2
    [ "$got" = "$cur" ] || bad="$bad $c"
  done
  if [ -n "$bad" ]; then
    trap - HUP INT TERM
    die "after the first umount these containers no longer see the current volume $cur:$bad. $DATA on the host now shows the old volume $old (read-only). Not touching anything else: look with docker exec, and remount the current volume ($(readlink -f "$(volume_link "$cur")")) at $DATA by hand if needed"
  fi

  if ! err=$(umount "$DATA" 2>&1); then
    trap - HUP INT TERM
    die "could not unmount the old volume from $DATA: $err. The host now shows the OLD volume there, read-only (containers are unaffected). To go back to the stacked state: mount -t xfs -o noatime $(readlink -f "$(volume_link "$cur")") $DATA && mount --make-shared $DATA. To retry: find what holds it with lsof +f -- $DATA, then umount $DATA again, then run $MOUNT_SCRIPT"
  fi
  if [ "$(data_mount_count)" != 0 ]; then
    trap - HUP INT TERM
    die "after the second umount there are still $(data_mount_count) mount(s) at $DATA (marker '$(read_marker "$DATA")'). Not touching anything else. Inspect with: findmnt --target $DATA; grep ' $DATA ' /proc/self/mountinfo"
  fi
  if ! err=$("$MOUNT_SCRIPT" 2>&1); then
    trap - HUP INT TERM
    echo "$err" >&2
    die "$MOUNT_SCRIPT failed; $DATA is now an EMPTY directory on the host (containers are unaffected). Fix the cause above and run $MOUNT_SCRIPT, or mount by hand: mount -t xfs -o noatime $(readlink -f "$(volume_link "$cur")") $DATA && mount --make-shared $DATA"
  fi
  trap - HUP INT TERM

  # What the next swap and the next deploy rely on.
  got=$(read_marker "$DATA")
  [ "$(data_mount_count)" = 1 ] || die "$DATA has $(data_mount_count) mounts after remounting, expected 1"
  [ "$got" = "$cur" ] || die "$DATA shows marker '$got' after remounting, expected $cur"
  [ "$(data_mount PROPAGATION)" = shared ] || die "$DATA is '$(data_mount PROPAGATION)' after remounting, expected shared"
  echo "mounts=1"
  echo "marker=$got"
  echo "propagation=shared"
  for c in $(containers); do
    pid=$(docker inspect -f '{{.State.Pid}}' "$c" 2> /dev/null || true)
    got=$(timeout 20 nsenter -t "$pid" -m -r cat "$CONTAINER_DATA/$MARKER" 2> /dev/null | tr -d '[:space:]' || true)
    echo "container.$c=${got:-unreadable}"
    [ "$got" = "$cur" ] || bad="$bad $c"
  done
  [ -z "$bad" ] || die "these containers do not see the current volume $cur:$bad (the host side is done: one shared mount of $cur)"
  # The namespaces which followed the host's mounts should have lost it too
  scan_mounts "$no_old"
  if [ -n "$M_OTHERS$M_FOLLOWERS" ]; then
    echo "$M_OTHERS$M_FOLLOWERS" >&2
    die "the host side is done, but $old is still mounted in the namespaces above: do not detach it. Unmount it there with nsenter -t <pid> -m umount $DATA (twice if the new volume is stacked on it), or restart that service"
  fi
  if [ "$(state_get old_volume)" = "$old" ]; then set_phase released; fi
  echo "released=yes"
  echo "old_volume=$old"
}

# grow-fs
##########################################################

# After modify-volume the NVMe device grows by itself; wait for it to show the
# new size, then grow XFS to fill it. XFS grows online, so this needs no
# freeze.
cmd_grow_fs() {
  local want=${1:-} dev have="" i size_before size_after
  [[ "$want" =~ ^[0-9]+$ ]] || die "usage: grow-fs <size-bytes>"
  dev=$(data_device)
  size_before=$(df -B1 --output=size "$DATA" | tail -n 1 | tr -d ' ')
  echo "fs_size_before=$size_before"
  if [ -n "$DRY_RUN" ]; then plan "wait for $dev to reach $want bytes, then xfs_growfs $DATA"; return 0; fi
  for ((i = 0; i < 90; i++)); do
    have=$(blockdev --getsize64 "$dev")
    [ "$have" -ge "$want" ] && break
    sleep 2
  done
  [ "$have" -ge "$want" ] || die "$dev is $have bytes after 3 minutes, expected $want"
  xfs_growfs "$DATA" > /dev/null
  size_after=$(df -B1 --output=size "$DATA" | tail -n 1 | tr -d ' ')
  echo "fs_size_after=$size_after"
  # xfs_growfs exits 0 even when it stopped short (see cmd_grow in resize.sh).
  [ "$size_after" -ge $((want / 100 * 95)) ] || die "the filesystem is $size_after bytes after xfs_growfs, expected about $want"
}

sub=${1:-}
[ $# -eq 0 ] || shift
case "$sub" in
  facts) cmd_facts ;;
  prepare) cmd_prepare "$@" ;;
  copy) cmd_copy "$@" ;;
  copy-status) cmd_copy_status "$@" ;;
  final-copy) cmd_final_copy "$@" ;;
  freeze-disk) cmd_freeze_disk "$@" ;;
  thaw-disk) cmd_thaw_disk ;;
  swap) cmd_swap ;;
  stop-copy) cmd_stop_copy ;;
  old-volume-status) cmd_old_volume_status "$@" ;;
  release-old) cmd_release_old "$@" ;;
  grow-fs) cmd_grow_fs "$@" ;;
  adopt) cmd_adopt "$@" ;;
  prewarm) cmd_prewarm "$@" ;;
  authorize-key) cmd_authorize_key "$@" ;;
  deauthorize-key) cmd_deauthorize_key ;;
  move-prepare) cmd_move_prepare "$@" ;;
  move-status) cmd_move_status ;;
  move-done) cmd_move_done ;;
  *) die "usage: host.sh [--dry-run] facts|prepare|copy|copy-status|final-copy|freeze-disk|thaw-disk|swap|stop-copy|old-volume-status|release-old|grow-fs|adopt|prewarm|authorize-key|deauthorize-key|move-prepare|move-status|move-done" ;;
esac
