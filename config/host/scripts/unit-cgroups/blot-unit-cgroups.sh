#!/bin/sh
# Installed by config/host/deploy.sh as /usr/local/sbin/blot-unit-cgroups.sh,
# run by blot-unit-cgroups.service. Safe to run again: it only makes
# directories and writes limits, so a changed limit is applied to a running
# unit.
#
# Each unit's sandbox jails (app/sandbox, BLOT_SANDBOX=1) live in the unit's
# slice beside its container, so the slice's MemoryMax bounds the whole unit
# (blotcms/blot#2795). The limits below stop one job from taking all of it:
#   sandbox/   image jobs, pandoc and fetches, nsjail's cgroup per job
#   browser/   one Chromium at a time (proxy/unit/sandbox/jail.js), which lives
#              here itself, so no subtree. oom.group: a page over the limit ends
#              the whole job at once, rather than leaving a browser hanging
#              until its time limit.
# proxy/deploy/common.sh binds the two into the unit and refuses to start one
# without them. systemd doesn't manage these two directories; it leaves them
# alone, and the slice's controllers stay on because the jails' own
# subtree_control uses them.
#
# Env, for tests: CGROUP_ROOT (/sys/fs/cgroup).
set -eu
root=${CGROUP_ROOT:-/sys/fs/cgroup}/system.slice/system-blot.slice
controllers="+memory +pids +cpu"

for unit in blue green; do
  slice=$root/system-blot-$unit.slice
  [ -d "$slice" ] || { echo "blot-unit-cgroups: $slice does not exist" >&2; exit 1; }
  echo "$controllers" > "$slice/cgroup.subtree_control"

  dir=$slice/sandbox
  mkdir -p "$dir"
  echo "$controllers" > "$dir/cgroup.subtree_control"
  echo 512M > "$dir/memory.max"
  echo 0 > "$dir/memory.swap.max"
  echo 256 > "$dir/pids.max"
  echo 25 > "$dir/cpu.weight"

  dir=$slice/browser
  mkdir -p "$dir"
  echo 1G > "$dir/memory.max"
  echo 0 > "$dir/memory.swap.max"
  echo 1 > "$dir/memory.oom.group"
  echo 512 > "$dir/pids.max"
  echo 25 > "$dir/cpu.weight"
  echo "150000 100000" > "$dir/cpu.max"
done
