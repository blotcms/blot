#!/bin/bash
# Usage: redis-sample.sh [--stdout]
# Runs on the Redis host, from cron every minute (install.sh adds the line).
# Appends one line to ~/perf/redis-sample.log: an ISO UTC timestamp, then
# space-separated key=value pairs (see README.md for what each one is).
# Cumulative counters are logged as the change since the previous run, which is
# kept in ~/perf/redis-sample.state; the first run, a Redis restart or a
# counter that went backwards gives x instead. Any value that cannot be read is
# x too: a failed field never breaks the line. The only things this reads from
# Redis are INFO, SLOWLOG, CONFIG GET and LATENCY LATEST (each wrapped in
# `timeout 5`); it changes nothing in Redis, including latency-monitor-threshold.
#
# --stdout prints the line instead of appending it (install.sh uses it).
# For tests: BLOT_ROOT prefixes /proc, PERF_DIR is where the log and state live,
# REDIS_CLI is the cli command (default redis6-cli, e.g. "redis-cli -p 6390").
set -euo pipefail

ROOT=${BLOT_ROOT:-}
PERF_DIR=${PERF_DIR:-$HOME/perf}
REDIS_CLI=${REDIS_CLI:-redis6-cli}
LOG=$PERF_DIR/redis-sample.log
STATE=$PERF_DIR/redis-sample.state
STDOUT=0
[ "${1:-}" = "--stdout" ] && STDOUT=1

mkdir -p "$PERF_DIR"

# One run at a time (cron fires every minute, a hung Redis can make a run slow).
if command -v flock > /dev/null 2>&1; then
  exec 9> "$PERF_DIR/redis-sample.lock"
  flock -n 9 || exit 0
fi

CUR=$(mktemp "$PERF_DIR/redis-sample.cur.XXXXXX")
trap 'rm -f "$CUR"' EXIT

# rcli <redis-cli args>: one Redis command, killed after 5s, CRs stripped.
# shellcheck disable=SC2086
rcli() { timeout 5 $REDIS_CLI "$@" 2> /dev/null | tr -d '\r'; }

# --- Gather: every raw value goes into $CUR as "key value" -------------------
echo "epoch $(date +%s)" >> "$CUR"

# /proc/stat: cumulative jiffies per CPU. Idle includes iowait; user includes nice.
awk '/^cpu[0-9]+ / {
  printf "%s.user %.0f\n%s.sys %.0f\n%s.idle %.0f\n%s.irq %.0f\n%s.softirq %.0f\n%s.steal %.0f\n%s.total %.0f\n",
    $1, $2 + $3, $1, $4, $1, $5 + $6, $1, $7, $1, $8, $1, $9,
    $1, $2 + $3 + $4 + $5 + $6 + $7 + $8 + $9
}' "$ROOT/proc/stat" >> "$CUR" 2> /dev/null || true

# /proc/softirqs: cumulative NET_RX and NET_TX counts, one column per CPU.
awk '$1 == "NET_RX:" {for (i = 2; i <= NF; i++) printf "netrx.%d %s\n", i - 2, $i}
     $1 == "NET_TX:" {for (i = 2; i <= NF; i++) printf "nettx.%d %s\n", i - 2, $i}' \
  "$ROOT/proc/softirqs" >> "$CUR" 2> /dev/null || true

# CPU pressure (PSI): the share of the last 10s/60s that some task waited for a CPU.
awk '$1 == "some" {split($2, a, "="); split($3, b, "="); print "psi.10 " a[2]; print "psi.60 " b[2]}' \
  "$ROOT/proc/pressure/cpu" >> "$CUR" 2> /dev/null || true

# TCP memory in pages (the number blotcms/blot#2041 is about).
awk '/^TCP:/ {for (i = 1; i < NF; i++) if ($i == "mem") print "tcpmem " $(i + 1)}' \
  "$ROOT/proc/net/sockstat" >> "$CUR" 2> /dev/null || true

# One plain INFO covers cpu, persistence, stats and clients. If it fails, Redis
# is down or stuck: skip the other calls (each could cost another 5s) and log x.
if INFO=$(rcli INFO) && [ -n "$INFO" ]; then
  printf '%s\n' "$INFO" | awk -F: '
    BEGIN {
      n = split("used_cpu_sys used_cpu_user used_cpu_sys_children used_cpu_user_children " \
        "rdb_bgsave_in_progress rdb_last_bgsave_time_sec rdb_current_bgsave_time_sec " \
        "rdb_last_bgsave_status rdb_changes_since_last_save rdb_last_save_time rdb_last_cow_size " \
        "latest_fork_usec total_commands_processed total_net_input_bytes total_net_output_bytes " \
        "total_connections_received instantaneous_ops_per_sec connected_clients uptime_in_seconds", names, " ")
      for (i = 1; i <= n; i++) want[names[i]] = 1
    }
    $1 in want && $2 != "" {print "info." $1 " " $2}' >> "$CUR"

  # Slowlog: length, and the id of the newest entry (ids only go up, so the
  # change in id is the number of new entries even when the log has wrapped).
  # `SLOWLOG GET 1` prints the newest entry's id on its first line.
  len=""
  if len=$(rcli SLOWLOG LEN) && [ -n "$len" ]; then echo "slow.len $len" >> "$CUR"; fi
  if [ "$len" = 0 ]; then
    echo "slow.id -1" >> "$CUR"
  elif [ -n "$len" ] && id=$(rcli SLOWLOG GET 1 | sed -n 1p) && [ -n "$id" ]; then
    echo "slow.id $id" >> "$CUR"
  fi

  # Latency monitor: only read when it is on, and never switched on from here.
  thr=$(rcli CONFIG GET latency-monitor-threshold | tail -n 1) || thr=""
  if [ -n "$thr" ] && [ "$thr" -gt 0 ] 2> /dev/null; then
    echo "lat.on 1" >> "$CUR"
    # raw output: event, unix time, latest ms, max ms (four lines per event)
    ev=$(rcli LATENCY LATEST | awk 'NF {v[++n] = $0} END {
      for (i = 1; i + 3 <= n; i += 4) printf "%s%s:%s/%s@%s", (i > 1 ? "," : ""), v[i], v[i + 2], v[i + 3], v[i + 1]
    }') || ev=""
    echo "lat.events ${ev:-none}" >> "$CUR"
  elif [ "$thr" = 0 ]; then
    echo "lat.on 0" >> "$CUR"
  fi
fi

# --- Compute: deltas against the previous run, then print the line -----------
PREV=$STATE
[ -s "$PREV" ] || PREV=/dev/null

LINE=$(awk -v ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  # d(k): current - previous for a cumulative counter, or x if either is missing
  # or it went backwards (counter reset, Redis restart).
  function d(k,   v) {
    if (!(k in p) || !(k in c)) return "x"
    v = c[k] - p[k]
    return v < 0 ? "x" : v
  }
  function f(v, fmt) { return v == "x" ? "x" : sprintf(fmt, v) }
  function raw(k) { return (k in c) ? c[k] : "x" }
  function pct(num, den) { return (num == "x" || den == "x" || den <= 0) ? "x" : sprintf("%.1f", 100 * num / den) }
  function out(k, v) { line = line " " k "=" v }

  FILENAME == ARGV[1] {p[$1] = $2; next}
  {c[$1] = $2}

  END {
    dt = d("epoch")
    line = ts
    out("dt", dt)
    # per-CPU busy % and its split, as a share of all jiffies in the interval
    for (n = 0; ("cpu" n ".total") in c; n++) {
      k = "cpu" n
      tot = d(k ".total")
      busy = (tot == "x" || d(k ".idle") == "x") ? "x" : tot - d(k ".idle")
      out(k "_busy", pct(busy, tot))
      out(k "_usr", pct(d(k ".user"), tot))
      out(k "_sys", pct(d(k ".sys"), tot))
      out(k "_irq", pct(d(k ".irq"), tot))
      out(k "_si", pct(d(k ".softirq"), tot))
      out(k "_steal", pct(d(k ".steal"), tot))
    }
    for (n = 0; ("netrx." n) in c; n++) out("netrx" n, d("netrx." n))
    for (n = 0; ("nettx." n) in c; n++) out("nettx" n, d("nettx." n))
    if ("psi.10" in c) {out("psi10", c["psi.10"]); out("psi60", c["psi.60"])} else out("psi", "off")

    # Redis CPU seconds used during the interval (children = the BGSAVE fork)
    out("rcpu_sys", f(d("info.used_cpu_sys"), "%.2f"))
    out("rcpu_usr", f(d("info.used_cpu_user"), "%.2f"))
    out("rcpu_csys", f(d("info.used_cpu_sys_children"), "%.2f"))
    out("rcpu_cusr", f(d("info.used_cpu_user_children"), "%.2f"))

    # BGSAVE. rdb_last_save_time moves when a save finishes. A restart moves it
    # too, so skip the delta when uptime went backwards.
    restarted = (("info.uptime_in_seconds" in c) && ("info.uptime_in_seconds" in p) && c["info.uptime_in_seconds"] + 0 < p["info.uptime_in_seconds"] + 0)
    saves = "x"
    if (("info.rdb_last_save_time" in c) && ("info.rdb_last_save_time" in p) && !restarted)
      saves = (c["info.rdb_last_save_time"] != p["info.rdb_last_save_time"]) ? 1 : 0
    now = raw("info.rdb_bgsave_in_progress")
    active = "x"
    if (now != "x") active = (now == 1 || p["info.rdb_bgsave_in_progress"] == 1 || saves == 1) ? 1 : 0
    out("bgsave", now)
    out("bgsaves", saves)
    out("bg_active", active)
    out("bgsave_sec", raw("info.rdb_last_bgsave_time_sec"))
    out("bgsave_cur_sec", raw("info.rdb_current_bgsave_time_sec"))
    out("bgsave_status", raw("info.rdb_last_bgsave_status"))
    out("changes", raw("info.rdb_changes_since_last_save"))
    out("fork_us", raw("info.latest_fork_usec"))
    out("cow_b", raw("info.rdb_last_cow_size"))

    out("cmds", d("info.total_commands_processed"))
    out("in_b", f(d("info.total_net_input_bytes"), "%.0f"))
    out("out_b", f(d("info.total_net_output_bytes"), "%.0f"))
    out("ops", raw("info.instantaneous_ops_per_sec"))
    out("conns_new", d("info.total_connections_received"))
    out("clients", raw("info.connected_clients"))
    out("uptime", raw("info.uptime_in_seconds"))

    out("slowlen", raw("slow.len"))
    out("slowid", raw("slow.id"))
    sn = "x"
    if (("slow.id" in c) && ("slow.id" in p) && c["slow.id"] + 0 >= p["slow.id"] + 0) sn = c["slow.id"] - p["slow.id"]
    out("slow_new", sn)

    if (!("lat.on" in c)) out("latmon", "x")
    else if (c["lat.on"] == 0) out("latmon", "off")
    else {out("latmon", "on"); out("lat", c["lat.events"])}

    out("tcpmem", raw("tcpmem"))
    print line
  }
' "$PREV" "$CUR")

mv "$CUR" "$STATE"
trap - EXIT

if [ "$STDOUT" = 1 ]; then
  echo "$LINE"
else
  echo "$LINE" >> "$LOG"
  # About a month of samples is 10MB; keep the previous file as .1 and start over.
  if [ "$(wc -c < "$LOG")" -gt 20000000 ]; then mv "$LOG" "$LOG.1"; fi
fi
