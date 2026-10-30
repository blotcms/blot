#!/bin/bash
# Usage: bootstrap.sh <ssh-host>
# Sets up a new Amazon Linux 2023 app host: copies host/, setup-deploy-user.sh
# and the Redis host files (config/redis) over and runs host/setup.sh with sudo,
# which sets up Redis too. Run it before config/host/deploy.sh. Safe to re-run
# on a live host (see host/setup.sh).
# Runs on a Mac, so it has to work in bash 3.2.
#
# Env: REDIS_MAXMEMORY        required, Redis's maxmemory (e.g. 10gb)
#      BLOT_SSH_PORT          the port sshd should listen on (optional)
#      BLOT_DEPLOY_PUBLIC_KEY the deploy user's ssh public key (optional)
#      SSH_OPTS               extra ssh options as one string, e.g.
#                             SSH_OPTS="-i $HOME/key.pem -p 22"
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(dirname "$(dirname "$HERE")")

die() { echo "error: $*" >&2; exit 1; }

ssh_run() {
  local host=$1
  shift
  # shellcheck disable=SC2086
  ssh -o BatchMode=yes -o ConnectTimeout=15 ${SSH_OPTS:-} "$host" "$@"
}

[ $# -eq 1 ] || die "usage: bootstrap.sh <ssh-host>"
HOST=$1
[ -n "${REDIS_MAXMEMORY:-}" ] || die "set REDIS_MAXMEMORY (e.g. 10gb): Redis's maxmemory, which has no default on an app host"

echo "Copying files to $HOST"
# COPYFILE_DISABLE stops macOS tar adding ._ files and extended attributes.
COPYFILE_DISABLE=1 tar -cf - -C "$HERE" host -C "$ROOT/scripts/deploy" setup-deploy-user.sh |
  ssh_run "$HOST" 'rm -rf /tmp/blot-host && mkdir /tmp/blot-host && tar -xf - -C /tmp/blot-host'
# The layout config/redis/host/setup.sh expects: its ROOT is the parent of host/.
COPYFILE_DISABLE=1 tar -cf - -C "$ROOT/config/redis" redis.conf bin host |
  ssh_run "$HOST" 'mkdir /tmp/blot-host/redis && tar -xf - -C /tmp/blot-host/redis'

echo "Running setup on $HOST"
# printf %q quotes the values for the remote shell.
ssh_run "$HOST" "sudo env REDIS_MAXMEMORY=$(printf %q "$REDIS_MAXMEMORY") BLOT_SSH_PORT=$(printf %q "${BLOT_SSH_PORT:-}") BLOT_DEPLOY_PUBLIC_KEY=$(printf %q "${BLOT_DEPLOY_PUBLIC_KEY:-}") bash /tmp/blot-host/host/setup.sh"

if [ -n "${BLOT_SSH_PORT:-}" ]; then
  echo "sshd now listens on port $BLOT_SSH_PORT only. Later ssh calls must use it (SSH_OPTS=\"-p $BLOT_SSH_PORT\"), and the security group must allow it."
fi
