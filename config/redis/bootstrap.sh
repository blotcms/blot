#!/bin/bash
# Usage: bootstrap.sh <ssh-host>
# Installs and configures Redis on a host: copies redis.conf and host/ over and
# runs host/setup.sh with sudo. Safe to re-run on a live host (it never restarts
# a running Redis; see host/setup.sh). Set REDIS_MAXMEMORY (e.g. 10gb) to
# override the default of 70% of RAM. See README.md.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

[ $# -eq 1 ] || die "usage: bootstrap.sh <ssh-host>"
HOST=$1

echo "Copying files to $HOST"
push_files "$HOST"

echo "Running setup on $HOST"
ssh_run "$HOST" "sudo env REDIS_MAXMEMORY='${REDIS_MAXMEMORY:-}' bash /tmp/blot-redis/host/setup.sh"
