#!/bin/bash
# Usage: cpu-squeeze.sh <redis-ssh-host> on|off|status
#        sudo cpu-squeeze.sh --local on|off|status      (on the Redis host itself)
# Confines everything that runs in userspace on the Redis host to CPU 0 and
# sends the network card's interrupts there too, so the 2-vCPU x2gd.large behaves
# like the 1-vCPU x2gd.medium it is to be replaced by (blotcms/blot#2041). Do not
# run it until the baseline in README.md is complete.
#
# Why this approximates an x2gd.medium: Graviton2 has no SMT, so a vCPU is a
# whole physical core, not a hyperthread. One core with everything on it, and
# the other left idle, is the same amount of CPU as the medium's one vCPU. It is
# not identical: the idle core still caches, the kernel threads that are pinned
# to CPU 1 (ksoftirqd/1, kworker/1:*) still exist but have nothing to do, and the
# instance still has the large's 2 ENA queues and its memory bandwidth.
#
# on      refuses to run if irqbalance is active (it would undo the IRQ masks).
#         Saves the current state to /root/blot-cpu-squeeze.state (kept if it is
#         already there, so a second `on` cannot overwrite the original values):
#         the smp_affinity of the NIC's IRQs (found by matching ens*/ena in
#         /proc/interrupts), the RPS masks in /sys/class/net/<if>/queues/rx-*/rps_cpus
#         and each unit's AllowedCPUs. Then `systemctl set-property --runtime
#         AllowedCPUs=0` on system.slice, user.slice and init.scope, the IRQs to
#         CPU 0 (mask 1) and RPS to mask 1. Then prints the verification below.
# off     puts back everything in the state file (AllowedCPUs back to what it
#         was, or all online CPUs, 0-1, if it was unset) and verifies.
# status  verifies: the AllowedCPUs of the three units, the IRQ and RPS masks,
#         redis6-server's affinity (taskset -cp) for every thread, and per-CPU
#         busy % over 5 seconds.
#
# Every command is printed before it runs. It does not touch CPU hotplug, restart
# any service or change the kernel's boot parameters. AllowedCPUs is set with
# --runtime, so a reboot also undoes it (the IRQ and RPS masks too). Both on and
# off can be repeated safely. Kernel threads are not covered by AllowedCPUs; only
# userspace is. XPS (transmit queue selection) is left alone: with all userspace
# on CPU 0 it picks CPU 0's queue by itself.
#
# NIC=<name> overrides the interface (default: the first ens*/eth*/enp* one).
# SSH_OPTS: see ../lib.sh. For tests, BLOT_ROOT prefixes /proc, /sys and /root.
set -euo pipefail

# The part that runs as root on the host. It is sent over ssh as text (declare -f),
# so everything it needs has to be inside it.
remote() {
  local action=$1
  local ROOT=${BLOT_ROOT:-}
  local STATE=$ROOT/root/blot-cpu-squeeze.state
  local UNITS="system.slice user.slice init.scope"

  # run <command...>: print it, then run it.
  run() { echo "+ $*"; "$@"; }
  # put <value> <file>: print and run `echo <value> > <file>`; a refusal is a warning.
  put() {
    echo "+ echo $1 > $2"
    echo "$1" > "$2" 2> /dev/null || echo "  warning: could not write $2 (the kernel refused)"
  }
  online_cpus() { cat "$ROOT/sys/devices/system/cpu/online"; }

  find_nic() {
    if [ -n "${NIC:-}" ]; then echo "$NIC"; return; fi
    local d
    for d in "$ROOT"/sys/class/net/*; do
      case "${d##*/}" in ens* | eth* | enp*) echo "${d##*/}"; return ;; esac
    done
  }
  # IRQ numbers of the NIC: ens5-Tx-Rx-N for the queues, ena-mgmnt@... for management.
  find_irqs() {
    awk -v nic="$1" '$1 ~ /^[0-9]+:$/ && ($NF ~ "^" nic "-" || $NF ~ /^ena/) {sub(":", "", $1); print $1}' "$ROOT/proc/interrupts"
  }
  redis_pids() {
    local d
    for d in "$ROOT"/proc/[0-9]*; do
      case "$(cat "$d/comm" 2> /dev/null || true)" in redis*-server) echo "${d##*/}" ;; esac
    done
  }

  verify() {
    local nic u irq f pid t n
    nic=$(find_nic)
    echo
    echo "== State (NIC $nic)"
    if [ -s "$STATE" ]; then echo "state file $STATE: present (squeezed)"; else echo "state file $STATE: absent (not squeezed)"; fi
    echo "irqbalance: $(systemctl is-active irqbalance 2> /dev/null || true)"
    for u in $UNITS; do
      echo "$u: AllowedCPUs=$(systemctl show -p AllowedCPUs --value "$u" 2> /dev/null || echo '?') EffectiveCPUs=$(systemctl show -p EffectiveCPUs --value "$u" 2> /dev/null || echo '?')"
    done
    for irq in $(find_irqs "$nic"); do
      echo "irq $irq ($(awk -v i="$irq:" '$1 == i {print $NF}' "$ROOT/proc/interrupts")): smp_affinity=$(cat "$ROOT/proc/irq/$irq/smp_affinity") list=$(cat "$ROOT/proc/irq/$irq/smp_affinity_list" 2> /dev/null || echo '?')"
    done
    for f in "$ROOT"/sys/class/net/"$nic"/queues/rx-*/rps_cpus; do
      [ -e "$f" ] && echo "rps ${f#"$ROOT"}: $(cat "$f")"
    done
    echo "NET_RX / NET_TX softirqs per CPU so far:"
    grep -E 'CPU0|NET_RX|NET_TX' "$ROOT/proc/softirqs" | sed 's/^/  /'

    echo
    echo "== redis6-server threads (taskset -cp)"
    n=0
    for pid in $(redis_pids); do
      for t in "$ROOT/proc/$pid/task/"*; do
        t=${t##*/}
        echo "  $pid/$t $(cat "$ROOT/proc/$pid/task/$t/comm" 2> /dev/null): $(taskset -cp "$t" 2> /dev/null | sed 's/.*: //')"
        n=$((n + 1))
      done
    done
    [ "$n" -gt 0 ] || echo "  no redis server process found"

    echo
    echo "== Per-CPU busy % over ${BUSY_SECS:-5}s"
    {
      grep '^cpu[0-9]' "$ROOT/proc/stat"
      echo --
      sleep "${BUSY_SECS:-5}"
      grep '^cpu[0-9]' "$ROOT/proc/stat"
    } | awk '$1 == "--" {second = 1; next}
      !second {for (i = 2; i <= 9; i++) t0[$1] += $i; i0[$1] = $5 + $6; next}
      {for (i = 2; i <= 9; i++) t1[$1] += $i; i1[$1] = $5 + $6}
      END {for (c in t1) if (t1[c] > t0[c]) printf "  %s busy %.1f%%\n", c, 100 * (1 - (i1[c] - i0[c]) / (t1[c] - t0[c]))}' | sort
  }

  case "$action" in
    on)
      if systemctl is-active --quiet irqbalance 2> /dev/null; then
        echo "error: irqbalance is active and would move the IRQs back. Stop it yourself first (systemctl stop irqbalance), and start it again after cpu-squeeze off." >&2
        return 1
      fi
      local nic irqs irq f u
      nic=$(find_nic)
      [ -n "$nic" ] || { echo "error: no network interface found (set NIC=)" >&2; return 1; }
      irqs=$(find_irqs "$nic")
      [ -n "$irqs" ] || { echo "error: no IRQs for $nic in /proc/interrupts" >&2; return 1; }

      if [ -s "$STATE" ]; then
        echo "State is already saved in $STATE; keeping those original values."
      else
        echo "Saving state to $STATE"
        mkdir -p "$(dirname "$STATE")"
        {
          echo "nic $nic"
          for irq in $irqs; do echo "irq $irq $(cat "$ROOT/proc/irq/$irq/smp_affinity")"; done
          for f in "$ROOT"/sys/class/net/"$nic"/queues/rx-*/rps_cpus; do
            [ -e "$f" ] && echo "rps $f $(cat "$f")"
          done
          for u in $UNITS; do echo "cpus $u $(systemctl show -p AllowedCPUs --value "$u")"; done
        } > "$STATE.tmp"
        mv "$STATE.tmp" "$STATE"
        sed 's/^/  /' "$STATE"
      fi

      echo "Confining userspace to CPU 0"
      for u in $UNITS; do run systemctl set-property --runtime "$u" AllowedCPUs=0; done
      echo "Pointing $nic interrupts and RPS at CPU 0"
      for irq in $irqs; do put 1 "$ROOT/proc/irq/$irq/smp_affinity"; done
      for f in "$ROOT"/sys/class/net/"$nic"/queues/rx-*/rps_cpus; do
        [ -e "$f" ] && put 1 "$f"
      done
      verify
      ;;

    off)
      if [ ! -s "$STATE" ]; then
        echo "Not squeezed ($STATE does not exist): nothing to restore."
        verify
        return 0
      fi
      local kind a b
      echo "Restoring from $STATE"
      # CPUs first, so userspace can spread out again, then the interrupts.
      while read -r kind a b; do
        [ "$kind" = cpus ] || continue
        run systemctl set-property --runtime "$a" "AllowedCPUs=${b:-$(online_cpus)}"
      done < "$STATE"
      while read -r kind a b; do
        case "$kind" in
          irq) put "$b" "$ROOT/proc/irq/$a/smp_affinity" ;;
          rps) put "$b" "$a" ;;
        esac
      done < "$STATE"
      mv "$STATE" "$STATE.restored"
      echo "State file moved to $STATE.restored"
      verify
      ;;

    status) verify ;;
    *) echo "usage: cpu-squeeze.sh <redis-ssh-host> on|off|status" >&2; return 2 ;;
  esac
}

# Nothing below runs when the file is sourced (tests do that).
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  [ $# -eq 2 ] || { echo "usage: cpu-squeeze.sh <redis-ssh-host> on|off|status" >&2; exit 2; }
  case "$2" in on | off | status) ;; *) echo "usage: cpu-squeeze.sh <redis-ssh-host> on|off|status" >&2; exit 2 ;; esac
  if [ "$1" = "--local" ]; then
    remote "$2"
  else
    . "$(dirname "$0")/common.sh"
    echo "Running '$2' on $1 (every command is printed before it runs)"
    ssh_run "$1" "sudo env NIC='${NIC:-}' bash -s" << EOF
set -euo pipefail
$(declare -f remote)
remote $2
EOF
  fi
fi
