#!/bin/sh
# Mounts the instance-store NVMe disk at /backups (local backup copies only).
# Run by blot-instance-store.service, a oneshot: a non-zero exit means "not
# mounted", and Redis still starts because it only Wants= this unit.
set -e

# Already mounted (the unit re-ran, or this is a reboot): only make sure the
# backup user owns it, which a host set up by the old root-run scripts lacks.
if mountpoint -q /backups; then
  echo "/backups is already mounted."
  chown ec2-user:ec2-user /backups
  exit 0
fi

# The instance-store disk is the NVMe device named as such by `nvme list`
# (the EBS root volume is listed as "Amazon Elastic Block Store").
DISK=$(nvme list | awk '/Amazon EC2 NVMe Instance Storage/ {print $1}' | head -n 1)

if [ -z "$DISK" ]; then
  echo "No NVMe instance store disk found!"
  exit 1
fi

# The disk keeps its filesystem across a reboot (only stop/start wipes it), so
# only format when it has none; mkfs on a populated disk would destroy backups.
if ! blkid "$DISK" >/dev/null 2>&1; then
  mkfs -t xfs "$DISK"
fi

mkdir -p /backups
mount "$DISK" /backups

# bin/backup.sh runs as ec2-user.
chown ec2-user:ec2-user /backups

# Make sure the mount landed rather than trusting mount's exit code alone.
mountpoint -q /backups
