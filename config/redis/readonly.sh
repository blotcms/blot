#!/bin/bash
# Usage: readonly.sh <ssh-host> on|off
# Turns a Redis master read-only (writes get a NOREPLICAS error) by setting
# min-replicas-to-write to 99, or back to 0. A runtime setting only, never
# written to the config, so a restart goes back to read-write.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

[ $# -eq 2 ] || die "usage: readonly.sh <ssh-host> on|off"
case "$2" in
  on) VALUE=99 ;;
  off) VALUE=0 ;;
  *) die "second argument must be on or off" ;;
esac

ssh_run "$1" "redis6-cli CONFIG SET min-replicas-to-write $VALUE | grep -qx OK" || die "CONFIG SET failed on $1"
echo "min-replicas-to-write on $1 is now: $(ssh_run "$1" "redis6-cli CONFIG GET min-replicas-to-write | tail -n 1")"
