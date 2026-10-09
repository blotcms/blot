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
#   old-volume-status <id>     is the old volume still mounted anywhere?
#   grow-fs <size-bytes>       xfs_growfs after an online EBS grow
#
# Every subcommand prints key=value lines on stdout (resize.sh parses them with
# field(), like config/redis/cutover.sh's gather) and anything else on stderr.
# A non-zero exit is a failure. --dry-run runs the checks that only read and
# prints what the rest would do.
#
# Why a mount swap and not a rename: the app containers bind the data directory
# with bind-propagation=rslave (config/host/scripts/mount-data-volume.sh makes
# the host mount shared), so a mount made on the host over the data directory
# shows up inside running containers at once. The old volume stays mounted
# underneath, read-only, until the containers are recreated and the host
# reboots.
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
MARKER=.blot-data-volume
LINK_PREFIX=/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol
UNIT_PREFIX=blot-data-copy-
LOCK=/run/blot-data-volume.lock
# The top-level directories whose children are copied by separate rsyncs in the
# frozen pass (final-copy). Everything else at the top level is one rsync.
SHARD_PARENTS=${SHARD_PARENTS:-"static blogs git"}
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
# anything already there is none of rsync's business. Not --inplace: it cannot
# be combined with -S, and sparse files must stay sparse or the used size
# would balloon on a smaller volume.
#
# The contents of logs/ and tmp/ are skipped (the directories are kept: cron
# appends to logs/expiring-certs.log, and the app expects tmp/ to exist). The
# marker is skipped so the new volume keeps its own, which prepare wrote and
# mount-data-volume.sh checks.
RSYNC_OPTS=(-aHAXS --numeric-ids --delete)
RSYNC_EXCLUDES=('--exclude=/.blot-data-volume' '--exclude=/logs/*' '--exclude=/tmp/*')

# Small helpers
##########################################################

valid_volume() { [[ "${1:-}" =~ ^vol-[0-9a-f]{8,17}$ ]] || die "not a volume ID: '${1:-}'"; }
volume_link() { echo "${LINK_PREFIX}${1#vol-}"; }
current_volume() { tr -d '[:space:]' < "$ID_FILE" 2> /dev/null || true; }
# <major>:<minor> of a block device, as /proc/*/mountinfo prints it.
devno() { printf '%d:%d' "0x$(stat -L -c %t "$1")" "0x$(stat -L -c %T "$1")"; }
# The mount points of a device in any mount namespace on the host (every
# container has its own), one per line. A bind mount of the same filesystem
# shows the same device number.
mounts_of() { { cat /proc/[0-9]*/mountinfo 2> /dev/null || true; } | awk -v d="$1" '$3 == d {print $5}' | sort -u; }
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
containers() { command -v docker > /dev/null && docker ps --format '{{.Names}}' | grep '^blot-container-' || true; }

state_get() { awk -F= -v k="$1" '$1 == k {print substr($0, length(k) + 2)}' "$STATE" 2> /dev/null || true; }
# Written to a temp file and renamed so a crash never leaves half a file.
state_write() {
  mkdir -p "$(dirname "$STATE")"
  printf 'old_volume=%s\nnew_volume=%s\nphase=%s\n' "$1" "$2" "$3" > "$STATE.tmp"
  mv "$STATE.tmp" "$STATE"
}
have() { command -v "$1" > /dev/null; }
# phase_in <phase>...: is the recorded phase one of these?
phase_in() { local p x; p=$(state_get phase); for x in "$@"; do [ "$p" != "$x" ] || return 0; done; return 1; }
set_phase() { state_write "$(state_get old_volume)" "$(state_get new_volume)" "$1"; }

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

stop_rsyncs() { pkill -TERM -f "rsync .*$NEW_MNT" || true; }

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
  local unit=${UNIT_PREFIX}$1.service st start_us exit_us now dur="" age=""
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
  if mountpoint -q "$NEW_MNT"; then echo "new_used_bytes=$(df -B1 --output=used "$NEW_MNT" | tail -n 1 | tr -d ' ')"; fi
}

cmd_copy() {
  local label=${1:-} unit st other
  [[ "$label" =~ ^[a-z0-9]+$ ]] || die "pass label must be lowercase letters and digits"
  unit=${UNIT_PREFIX}$label.service
  precondition "phase is '$(state_get phase)', not prepared (see $STATE)" [ "$(state_get phase)" = prepared ]
  precondition "$NEW_MNT is not mounted: run prepare first" mountpoint -q "$NEW_MNT"
  precondition "rsync is not installed" have rsync
  st=$(unit_state "$unit")
  if [ "$st" = running ] || [ "$st" = ok ]; then unit_report "$label"; return 0; fi
  for other in $(copy_units); do
    [ "$other" = "$unit" ] || [ "$(unit_state "$other")" != running ] || die "$other is still running"
  done
  if [ -n "$DRY_RUN" ]; then
    plan "systemd-run --unit=${unit%.service} --remain-after-exit --property=Nice=10 ionice -c 3 rsync (exit 24 counts as success) ${RSYNC_OPTS[*]} --stats ${RSYNC_EXCLUDES[*]} $DATA/ $NEW_MNT/"
    return 0
  fi
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
    "${RSYNC_OPTS[@]}" --stats "${RSYNC_EXCLUDES[@]}" "$DATA/" "$NEW_MNT/" > /dev/null
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
  local budget=${1:-0} ex p shards=0 start rc=0 wd="" i_old
  precondition "rsync is not installed" have rsync
  precondition "phase is '$(state_get phase)', not prepared" phase_in prepared copied
  precondition "$NEW_MNT is not mounted: run prepare first" mountpoint -q "$NEW_MNT"
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
    plan "rsync ${RSYNC_OPTS[*]} ${ex[*]} $DATA/ $NEW_MNT/"
    plan "per shard parent ($SHARD_PARENTS): rsync -dlptgoD -AXS --numeric-ids --delete"
    plan "$shards rsyncs of the child directories, $FINAL_COPY_JOBS at a time, then sync; phase=copied"
    return 0
  fi
  take_lock
  work=$(mktemp -d /tmp/blot-final-copy.XXXXXX)
  trap 'stop_rsyncs; rm -rf "$work"' EXIT
  trap 'exit 143' INT TERM HUP
  start=$(date +%s)
  # A budget lets the caller keep the copy inside the read-only freeze's TTL.
  if [ "$budget" -gt 0 ]; then
    ( sleep "$budget"; echo "error: the final copy ran past its ${budget}s budget; stopping it" >&2; touch "$work/over"; stop_rsyncs ) &
    wd=$!
  fi

  rsync "${RSYNC_OPTS[@]}" "${ex[@]}" "$DATA/" "$NEW_MNT/" || rc=$?
  if [ "$rc" = 0 ]; then
    for p in $SHARD_PARENTS; do
      [ -d "$DATA/$p" ] || continue
      rsync -dlptgoD -HAXS --numeric-ids --delete "$DATA/$p/" "$NEW_MNT/$p/" || { rc=$?; break; }
      find "$DATA/$p" -mindepth 1 -maxdepth 1 -type d -printf "$p/%f\\0" >> "$work/list"
    done
  fi
  if [ "$rc" = 0 ] && [ -s "$work/list" ]; then
    shards=$(tr -cd '\0' < "$work/list" | wc -c)
    export DATA NEW_MNT work
    export -f shard_copy
    # xargs keeps going when one shard fails and exits 123; each failure is
    # recorded in $work/failed so the summary can name it.
    xargs -0 -n 1 -P "$FINAL_COPY_JOBS" -a "$work/list" bash -c 'shard_copy "$1"' _ || rc=$?
  fi
  [ -z "$wd" ] || { pkill -P "$wd" 2> /dev/null || true; kill "$wd" 2> /dev/null || true; wait "$wd" 2> /dev/null || true; }
  if [ -e "$work/over" ]; then die "over the ${budget}s budget"; fi
  if [ -s "$work/failed" ]; then echo "failed shards:" >&2; cat "$work/failed" >&2; fi
  [ "$rc" = 0 ] || die "the final copy failed (rsync exit $rc)"
  sync
  set_phase copied
  i_old=$(df --output=iused "$DATA" | tail -n 1 | tr -d ' ')
  echo "final_copy=ok"
  echo "shards=$shards"
  echo "duration_s=$(($(date +%s) - start))"
  echo "new_used_bytes=$(df -B1 --output=used "$NEW_MNT" | tail -n 1 | tr -d ' ')"
  echo "inodes_old=$i_old"
  echo "inodes_new=$(df --output=iused "$NEW_MNT" | tail -n 1 | tr -d ' ')"
}

# shard_copy <path relative to the data directory>: one child directory.
# Exported for xargs; it recreates the path under the same parent on the target.
shard_copy() {
  local rc=0
  rsync -aHAXS --numeric-ids --delete "$DATA/$1" "$NEW_MNT/${1%/*}/" || rc=$?
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

# old-volume-status
##########################################################

# After a swap the old volume stays mounted, stacked under the new one on the
# host and in every container, until the containers are recreated and the host
# reboots. It can be detached once no mount namespace has it. A mount of a
# volume in a container's own namespace does not show up in the host's
# /proc/self/mountinfo, hence the scan of every process.
cmd_old_volume_status() {
  local id=${1:-} link dev m
  valid_volume "$id"
  echo "current=$([ "$(current_volume)" = "$id" ] && echo yes || echo no)"
  link=$(volume_link "$id")
  if [ ! -e "$link" ]; then
    echo "device=absent"
    echo "mounted=no"
    return 0
  fi
  dev=$(readlink -f "$link")
  echo "device=$dev"
  m=$(mounts_of "$(devno "$dev")")
  if [ -n "$m" ]; then echo "mounted=yes"; else echo "mounted=no"; fi
  for dev in $m; do echo "mount=$dev"; done
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
  grow-fs) cmd_grow_fs "$@" ;;
  *) die "usage: host.sh [--dry-run] facts|prepare|copy|copy-status|final-copy|freeze-disk|thaw-disk|swap|stop-copy|old-volume-status|grow-fs" ;;
esac
