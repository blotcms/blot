#!/bin/sh

set -e

# Mount EBS data volume to /var/www/blot/data
##########################################################
# This is part of the upstart script for Blot so if 
# you move it, make sure to update the upstart script

ROOTDISK=$(lsblk -no PKNAME $(findmnt -n -o SOURCE /) | head -n1)
EBS_DISK=$(nvme list | awk '/Elastic Block Store/ {print $1}' | grep -v "/dev/$ROOTDISK")

# If you change the cache directory, make sure to update
# the cache_directory default in proxy/build/locals.js
mkdir -p /var/www/blot/data

if [ -z "$EBS_DISK" ]; then
  echo "No EBS data disk found!"
  exit 1
fi

# Check if already mounted
if mountpoint -q /var/www/blot/data; then
    echo "/var/www/blot/data is already mounted."
else
    mount "$EBS_DISK" /var/www/blot/data
    echo "Mounted $EBS_DISK to /var/www/blot/data"
fi