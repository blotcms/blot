#!/bin/bash
# Usage: readonly.sh <ssh-host> on|off
# Turns a Redis master read-only (writes get a NOREPLICAS error) by setting
# min-replicas-to-write to 99, or back to 0. A runtime setting only, never
# written to the config, so a restart goes back to read-write.
#
# Checked on 6.2.12: this refuses plain writes, MULTI/EXEC and writes inside
# EVAL/EVALSHA, with or without a replica attached. Script writes fail as
# "ERR Error running script ... -NOREPLICAS ...", not "NOREPLICAS ...". It
# only works while min-replicas-max-lag is above 0 (0 turns the check off),
# so that is checked first. For a host switch use cutover.sh, which uses
# FAILOVER instead.
set -euo pipefail
. "$(dirname "$0")/lib.sh"

[ $# -eq 2 ] || die "usage: readonly.sh <ssh-host> on|off"
case "$2" in
  on) VALUE=99 ;;
  off) VALUE=0 ;;
  *) die "second argument must be on or off" ;;
esac

if [ "$VALUE" != 0 ]; then
  lag=$(ssh_run "$1" "redis6-cli CONFIG GET min-replicas-max-lag | tail -n 1")
  [ "$lag" -gt 0 ] 2> /dev/null || die "min-replicas-max-lag is '$lag' on $1; at 0 min-replicas-to-write does nothing"
fi
ssh_run "$1" "redis6-cli CONFIG SET min-replicas-to-write $VALUE | grep -qx OK" || die "CONFIG SET failed on $1"
echo "min-replicas-to-write on $1 is now: $(ssh_run "$1" "redis6-cli CONFIG GET min-replicas-to-write | tail -n 1")"
