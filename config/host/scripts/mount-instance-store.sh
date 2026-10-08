#!/bin/sh

# mount-instance-store.service runs this as Type=oneshot: systemd (and the
# docker.service.d drop-in that Requires= this unit) treats a non-zero exit
# as failure, so every step below must actually abort the script on error
# rather than leave it to silently fall through to `mount` returning success
# on an empty/unformatted disk. The final mountpoint check is what makes a
# oneshot "success" actually mean "mounted".
set -e

# Mount ephemeral disk to cache
##########################################################
# This is part of the upstart script for Blot so if
# you move it, make sure to update the upstart script


# Already mounted (e.g. this ran once already, or the unit is re-run):
# nothing to do.
if mountpoint -q /var/instance-ssd; then
  echo "/var/instance-ssd is already mounted."
  exit 0
fi

# List all NVMe devices, grep for the instance storage, and extract the device name
EPHEMERAL_DISK=$(nvme list | awk '/Amazon EC2 NVMe Instance Storage/ {print $1}' | head -n 1)

if [ -z "$EPHEMERAL_DISK" ]; then
  echo "No ephemeral NVMe instance disk found!"
  exit 1
fi

# Instance store data survives a reboot (only a stop/start of the instance
# wipes it), so on reboot the disk already has our XFS filesystem on it and
# the cache is still warm. Only format it if it has no filesystem yet: an
# unconditional `mkfs -t xfs` would either refuse (without -f) and fail the
# oneshot unit on every reboot, or (with -f) silently wipe the warm cache.
if ! blkid "$EPHEMERAL_DISK" >/dev/null 2>&1; then
  # Once we work out which disk is the ephemeral disk
  # we create a file system on it and mount it to the cache
  # directory, which is used by the application and NGINX
  # to store cached rendered web pages
  mkfs -t xfs "$EPHEMERAL_DISK"
fi

# If you change the cache directory, make sure to update
# the build-config.js propert 'cache_directory'
mkdir -p /var/instance-ssd

mount "$EPHEMERAL_DISK" /var/instance-ssd

# Belt and braces: make sure the mount actually landed, rather than trusting
# `mount`'s exit code alone.
mountpoint -q /var/instance-ssd
