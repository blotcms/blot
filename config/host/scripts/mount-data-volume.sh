#!/bin/bash

# mount-data-volume.service runs this as Type=oneshot: systemd (and the
# docker.service.d drop-in that Wants= this unit) treats a non-zero exit as
# failure, so every step below must abort the script on error rather than
# leave Docker to start containers against an empty /var/www/blot/data on
# the root disk. Output goes to stdout, which journald collects
# (`journalctl -u mount-data-volume`).
set -euo pipefail

DATA_DIRECTORY=/var/www/blot/data
VOLUME_ID_FILE=/etc/blot/data-volume
MARKER_FILE="$DATA_DIRECTORY/.blot-data-volume"
WAIT_SECONDS=60

# Which volume belongs here
##########################################################
# /etc/blot/data-volume holds the ID of the EBS volume that should be
# mounted at the data directory, one line, e.g. vol-0a2e04d301e025e60. It is
# host state, not repo state: the ID changes every time the volume is
# swapped (resized, restored from a snapshot). deploy.sh writes it the first
# time it runs on a host that already has the volume mounted; the volume swap
# script updates it. Everything below refuses to mount anything else.

if [ ! -f "$VOLUME_ID_FILE" ]; then
  echo "$VOLUME_ID_FILE is missing: it should hold the EBS volume ID of the data volume (e.g. vol-0a2e04d301e025e60)."
  exit 1
fi

VOLUME_ID=""
read -r VOLUME_ID < "$VOLUME_ID_FILE" || true
VOLUME_ID=$(printf '%s' "$VOLUME_ID" | tr -d '[:space:]')

if ! [[ "$VOLUME_ID" =~ ^vol-[0-9a-f]{8,17}$ ]]; then
  echo "$VOLUME_ID_FILE is malformed: expected a volume ID like vol-0a2e04d301e025e60, found '$VOLUME_ID'."
  exit 1
fi

# EBS volumes appear on NVMe instances as
# /dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol<id without the dash>.
# The /dev/nvmeXn1 name itself is not stable across reboots or attaches, so
# never use that to decide which disk to mount.
DEVICE_LINK="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${VOLUME_ID/-/}"

# The device can show up a little after boot (or after an attach), so wait
# for it rather than failing the unit on a race.
for ((i = 0; i < WAIT_SECONDS; i++)); do
  [ -e "$DEVICE_LINK" ] && break
  sleep 1
done

if [ ! -e "$DEVICE_LINK" ]; then
  echo "$DEVICE_LINK did not appear within ${WAIT_SECONDS}s: is $VOLUME_ID attached to this instance?"
  exit 1
fi

DEVICE=$(readlink -f "$DEVICE_LINK")

# Belt and braces: make sure it is our data volume and not some other XFS
# volume (or a blank one) that happens to be at that device. The marker file
# is written by deploy.sh when it adopts a volume, and must be put on any
# replacement volume before it is swapped in. Its content is the volume ID
# so that a marker copied onto the wrong volume still fails.
marker_matches() {
  local marker=""
  if [ -f "$MARKER_FILE" ]; then
    read -r marker < "$MARKER_FILE" || true
    marker=$(printf '%s' "$marker" | tr -d '[:space:]')
  fi
  [ "$marker" = "$VOLUME_ID" ] && return 0
  echo "$MARKER_FILE says '$marker', expected $VOLUME_ID."
  return 1
}

# Already mounted (e.g. this ran once already, docker.service's ExecStartPre
# runs it again, or the volume was mounted by hand): nothing to mount, as long
# as it is the right volume with the right marker. A different device here
# means something else was mounted over the data directory; do not paper over
# that, and do not unmount it either: leave it for a person to look at.
if mountpoint -q "$DATA_DIRECTORY"; then
  # findmnt prints bind-mounted sources as /dev/xxx[/subdir]; drop the [...]
  MOUNTED_SOURCE=$(findmnt -n -o SOURCE --target "$DATA_DIRECTORY")
  MOUNTED_DEVICE=$(readlink -f "${MOUNTED_SOURCE%%[*}")

  if [ "$MOUNTED_DEVICE" != "$DEVICE" ]; then
    echo "$DATA_DIRECTORY is mounted from $MOUNTED_DEVICE, but $VOLUME_ID is $DEVICE."
    exit 1
  fi

  marker_matches || exit 1

  echo "$DATA_DIRECTORY is already mounted from $DEVICE ($VOLUME_ID)."
  mount --make-shared "$DATA_DIRECTORY"
  exit 0
fi

mkdir -p "$DATA_DIRECTORY"

mount -t xfs -o noatime "$DEVICE" "$DATA_DIRECTORY"
echo "Mounted $DEVICE ($VOLUME_ID) at $DATA_DIRECTORY."

if ! marker_matches; then
  echo "Unmounting $DEVICE."
  umount "$DATA_DIRECTORY"
  exit 1
fi

# App containers bind the data directory with bind-propagation=rslave (see
# scripts/deploy/util/generateDockerCommand.js) so a mount made here reaches
# them without a restart. Docker only allows that if the host mount is shared.
mount --make-shared "$DATA_DIRECTORY"
echo "$DATA_DIRECTORY is mounted and shared."
