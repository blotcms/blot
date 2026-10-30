#!/bin/bash
# Usage: bootstrap.sh <ssh-host>
# Sets up a new Amazon Linux 2023 app host: copies host/ and
# setup-deploy-user.sh over and runs host/setup.sh with sudo. Run it before
# `npm run deploy-host`. Safe to re-run on a live host (see host/setup.sh).
# Runs on a Mac, so it has to work in bash 3.2.
#
# Env: BLOT_SSH_PORT          the port sshd should listen on (optional)
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

echo "Copying files to $HOST"
# COPYFILE_DISABLE stops macOS tar adding ._ files and extended attributes.
COPYFILE_DISABLE=1 tar -cf - -C "$HERE" host -C "$ROOT/scripts/deploy" setup-deploy-user.sh |
  ssh_run "$HOST" 'rm -rf /tmp/blot-host && mkdir /tmp/blot-host && tar -xf - -C /tmp/blot-host'

echo "Running setup on $HOST"
# printf %q quotes the values for the remote shell.
ssh_run "$HOST" "sudo env BLOT_SSH_PORT=$(printf %q "${BLOT_SSH_PORT:-}") BLOT_DEPLOY_PUBLIC_KEY=$(printf %q "${BLOT_DEPLOY_PUBLIC_KEY:-}") bash /tmp/blot-host/host/setup.sh"

if [ -n "${BLOT_SSH_PORT:-}" ]; then
  echo "sshd now listens on port $BLOT_SSH_PORT only. Later ssh calls must use it (SSH_OPTS=\"-p $BLOT_SSH_PORT\"), and the security group must allow it."
fi
