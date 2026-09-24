#!/bin/sh

# mount-instance-store.service runs this as Type=oneshot: systemd (and the
# docker.service.d drop-in that Requires= this unit) treats a non-zero exit
# as failure, so every step below must actually abort the script on error
# rather than leave it to silently fall through to `mount` returning success
# on an empty/unformatted disk.
set -e

# Mount ephemeral disk to cache
##########################################################
# This is part of the upstart script for Blot so if
# you move it, make sure to update the upstart script


# List all NVMe devices, grep for the instance storage, and extract the device name
EPHEMERAL_DISK=$(nvme list | awk '/Amazon EC2 NVMe Instance Storage/ {print $1}' | head -n 1)

if [ -z "$EPHEMERAL_DISK" ]; then
  echo "No ephemeral NVMe instance disk found!"
  exit 1
fi

# Once we work out which disk is the ephemeral disk
# we create a file system on it and mount it to the cache 
# directory, which is used by the application and NGINX
# to store cached rendered web pages
mkfs -t xfs $EPHEMERAL_DISK

# If you change the cache directory, make sure to update
# the build-config.js propert 'cache_directory'
mkdir -p /var/instance-ssd

mount $EPHEMERAL_DISK /var/instance-ssd
