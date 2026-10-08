# Redis on one CPU: baseline and squeeze

Tools to measure how Blot's Redis behaves on one CPU, before moving it from the
2-vCPU x2gd.large to a 1-vCPU x2gd.medium (blotcms/blot#2041). Two phases on
the **current** host:

1. **Baseline:** collect the metrics below for at least 24 hours, as the host is today.
2. **Squeeze:** confine all userspace and the network card's interrupts to CPU 0
   for 2-3 hours (`cpu-squeeze.sh on`), then compare those hours with the same
   hours of the baseline.

Graviton has no SMT, so one vCPU is one physical core: one busy core plus one
idle core is the same compute as the medium's single vCPU. See the header of
`cpu-squeeze.sh` for what it does not reproduce.

**Redis's config is not touched in either phase.** `save 60 10000` stays (a ~30s
BGSAVE every 1-2 minutes is the worst case being tested), and nothing here sets
`latency-monitor-threshold` or any other Redis setting: the collectors only run
`INFO`, `SLOWLOG`, `CONFIG GET` and `LATENCY LATEST`, plus `PING`.

| File | What it does |
| --- | --- |
| `install.sh <redis-ssh-host> <app-ssh-host> <redis-private-ip>` | Copy the collectors to `~/perf/` on both hosts, check prerequisites, add `# blot-perf` cron lines, run each once. `--uninstall` removes only those lines. |
| `redis-sample.sh` | Redis host, cron every minute: CPU, softirqs, pressure, Redis INFO deltas, BGSAVE, slowlog, TCP memory. |
| `latency-probe.py` | Redis host (to 127.0.0.1) and app host (to the Redis private IP), cron every minute: 50ms PINGs for ~55s plus one 250KB pipelined burst. |
| `fetch.sh <redis-ssh-host> <app-ssh-host>` | Copy the logs to `data/redis-perf/<host>/` and count the app's `[LOCK]` lines per minute. |
| `compare.js` | Side-by-side summary of two time windows. |
| `cpu-squeeze.sh <redis-ssh-host> on\|off\|status` | The squeeze. **Not to be run until the baseline is complete.** |

Operator scripts run on a Mac (bash 3.2). The Redis host's sshd uses a custom port:
set `SSH_OPTS` (for example `SSH_OPTS="-p 3796 -i ~/key.pem"`) or use `~/.ssh/config`
aliases, as for the other scripts in `config/redis/`. If the app host needs
different options, `APP_SSH_OPTS` replaces `SSH_OPTS` for it. The hosts need
`python3`, `flock`, `timeout` and `crontab` (cronie: `dnf install cronie &&
systemctl enable --now crond`), and `redis6-cli` on the Redis host; `install.sh`
checks before it changes anything.

## Procedure

All times are UTC, in the logs and in `compare.js`.

1. **Install** (from this directory):

   ```
   ./install.sh <redis-ssh-host> <app-ssh-host> <redis-private-ip>
   ```

   It prints one sample line and one probe line from each host. Check them (see
   "On first install" below), then wait a few minutes and look at
   `ssh <host> 'tail -n 3 ~/perf/*.log'`. Cron errors go to `~/perf/cron.log`.
2. **Baseline:** leave it for at least 24 hours, so every hour of the day has been
   seen once, including the :00 hourly backups. Avoid deploying: a deploy replaces
   the app containers and their docker logs (the `[LOCK]` counts) with them.
3. **Pick the squeeze window.** 2-3 hours that include at least one :00 hourly
   backup, at a time of day that is also in the baseline (e.g. 13:50 to 16:10 UTC).
4. **Squeeze:** `./cpu-squeeze.sh <redis-ssh-host> on`. It prints each command and
   then the verification: redis6-server's threads should all show affinity `0`,
   the NIC IRQs mask `1`, and `cpu1` should be near idle. Stop `irqbalance`
   yourself first if it is running (the script refuses otherwise). Watch it, see
   below.
5. **Release:** `./cpu-squeeze.sh <redis-ssh-host> off`, and check the verification
   shows everything back (`cpu1` busy again, IRQ masks as before).
   `./cpu-squeeze.sh <redis-ssh-host> status` shows the state any time.
   The saved state (`/root/blot-cpu-squeeze.state`) records the boot it was taken
   in: if the host rebooted since, the reboot already undid the squeeze, so `off`
   restores nothing and `on` takes new state, moving the old file to
   `*.stale.<time>`.
6. **Fetch:** `./fetch.sh <redis-ssh-host> <app-ssh-host>` (`--since 3d` limits the
   docker log window; the default is 7d).
7. **Compare:** the baseline is the 24h before the squeeze, `--match-hours` keeps
   only the baseline hours of the day the test window covers:

   ```
   node compare.js --baseline 2026-10-09T14:00..2026-10-10T14:00 \
     --test 2026-10-10T14:00..16:00 --match-hours
   ```

   A time is `YYYY-MM-DD[THH[:MM]]`; the end of a window may be just `HH[:MM]`.
   Leave a few minutes at each end of the test window for `cpu-squeeze on`/`off`
   to settle. It finds the logs under `data/redis-perf/` by itself if one
   directory there has each (`--data`, `--redis-dir` and `--app-dir` override, and
   are needed when several do).
8. **Clean up:** `./install.sh --uninstall <redis-ssh-host> <app-ssh-host>` removes
   the cron lines (other crontab entries are untouched; the old crontab is saved as
   `~/perf/crontab.bak.<ts>`). Logs and scripts stay in `~/perf/` until you delete them.

## What to watch during the squeeze, and when to abort

From the Mac, every few minutes (these only read the small logs):

```
ssh <redis-ssh-host> 'tail -n 3 ~/perf/latency-redis-local.log; tail -n 1 ~/perf/redis-sample.log'
ssh <app-ssh-host> 'tail -n 3 ~/perf/latency-app-to-redis.log'
ssh <app-ssh-host> 'docker logs --since 10m blot-container-green 2>&1 | grep -c "\[LOCK\] slow heartbeat"'
```

Run `cpu-squeeze.sh ... off` (it takes a second or two) if you see:

- **`max` over 1000 (ms) in the probe lines**, on either probe, in more than one or
  two minutes in a row, or any `err` / `reconn` above 0. The app's sync
  lock has a 10s TTL renewed every 3s, so seconds-long stalls are what lose it.
- **`[LOCK] slow heartbeat` counts climbing** compared with the quiet baseline (the
  app's own early warning, over 500ms), and any `[LOCK COMPROMISED]` at all.
- **`tcpmem` jumping** (pages, from `/proc/net/sockstat`; the quantity behind
  the TCP memory leak in #2041) rather than wobbling as in the baseline, or
  `burst_ms` going from tens of milliseconds to seconds.

Also keep an eye on `psi10` (CPU pressure) and `cpu0_busy` for saturation, but
those are expected to rise; the stalls above are what matter. Expect `cpu0_busy`
to climb and `cpu1_busy` to fall to ~0 right after `on`.

## Load added

Tiny. Each minute: `redis-sample.sh` makes four to five `redis6-cli` calls
(`INFO`, `SLOWLOG` twice, `CONFIG GET`, `LATENCY LATEST` only if the monitor is
on) and reads a few `/proc` files. Each probe holds one connection and sends ~1,100
`PING`s of 14 bytes, and once a minute one burst of ~17,900 `PING`s (250KB) whose
~125KB of replies it reads straight back. That is about 19,000 trivial commands a
minute per probe, with two probes (one local, one from the app host): a few tens of
milliseconds of Redis CPU a minute. The burst is the one thing that looks like the
incident's symptom, and a one-off 250KB pipelined write once a minute is the
point of it.

## Log lines

Every line starts with an ISO UTC timestamp, then `key=value` pairs. `x` means
"not available" (a failed `redis6-cli` call, the first run, a counter reset by a
Redis restart); it never breaks the line. Logs rotate to `.1` at 20MB.

**`~/perf/redis-sample.log`** (Redis host): the timestamp is the **end** of the
interval, `dt` seconds long. All deltas are over the interval.

| Key | Meaning |
| --- | --- |
| `dt` | seconds since the previous sample |
| `cpuN_busy`, `_usr`, `_sys`, `_irq`, `_si`, `_steal` | % of that CPU's time (busy = not idle/iowait; usr includes nice) |
| `netrxN`, `nettxN` | NET_RX / NET_TX softirqs handled by CPU N during the interval |
| `psi10`, `psi60` | `/proc/pressure/cpu` some avg10 / avg60, %; `psi=off` if the kernel lacks it |
| `rcpu_sys`, `rcpu_usr`, `rcpu_csys`, `rcpu_cusr` | Redis CPU seconds used (`used_cpu_*`; `c` = BGSAVE child) |
| `bgsave` | `rdb_bgsave_in_progress` at the sample instant |
| `bgsaves` | BGSAVEs completed during the interval (`rdb_last_save_time` changed) |
| `bg_active` | 1 if a BGSAVE was running at any point of the interval (running now, running at the previous sample, or completed in between) |
| `bgsave_sec`, `bgsave_cur_sec`, `bgsave_status` | `rdb_last_bgsave_time_sec`, `rdb_current_bgsave_time_sec`, `rdb_last_bgsave_status` (stays `err` until the next good save) |
| `changes` | `rdb_changes_since_last_save` |
| `fork_us`, `cow_b` | `latest_fork_usec`, `rdb_last_cow_size` (bytes) |
| `cmds`, `in_b`, `out_b` | `total_commands_processed` and `total_net_input_bytes` / `_output_bytes` deltas |
| `ops`, `clients`, `uptime` | `instantaneous_ops_per_sec`, `connected_clients`, `uptime_in_seconds` |
| `conns_new` | `total_connections_received` delta |
| `slowlen`, `slowid`, `slow_new` | `SLOWLOG LEN`, id of the newest entry (-1 if empty), new entries since the previous sample |
| `latmon` | `off` when `latency-monitor-threshold` is 0; otherwise `on` and `lat=event:latest_ms/max_ms@unixtime,...` from `LATENCY LATEST` (`lat=none` if empty) |
| `tcpmem` | TCP `mem` pages from `/proc/net/sockstat` |

**`~/perf/latency-redis-local.log`** (Redis host) and
**`~/perf/latency-app-to-redis.log`** (app host): the timestamp is the **start** of
the ~55s run.

| Key | Meaning |
| --- | --- |
| `label` | `redis-local` or `app-to-redis` |
| `n`, `err`, `reconn` | PINGs timed, failed PINGs (no reply in 3s, reset, bad reply), reconnects |
| `conn_ms` | time to open the connection |
| `p50`, `p90`, `p99`, `p999`, `max` | round trip, ms. A failed PING counts as a sample of the time it took to fail |
| `max_sec` | second of the minute (UTC) the slowest PING was sent |
| `gt10`, `gt50`, `gt100`, `gt1000` | PINGs slower than 10ms / 50ms / 100ms / 1s |
| `burst_ms`, `burst_n` | time to write `burst_n` PINGs (~250KB) in one go and read every reply; `x` if it failed |
| `timeout=1` | the run hit its hard 70s limit and logged what it had |

A run that finds the previous one still going exits without logging, so a minute
can be missing after a long stall.

**`data/redis-perf/<app-host>/app-lock.log`** (made by `fetch.sh`, one line per
container per minute that had any): `<minute> container=<blue|green|yellow>
slow=<[LOCK] slow heartbeat lines> compromised=<[LOCK COMPROMISED] lines>`.

## On first install

`install.sh` was only tested against local stand-ins (a `redis:6.2` container and
fake `/proc` files), never on the hosts. In the first output, check:

- the `redis-sample.sh` line has numbers (not `x`) for `cpu0_busy`..., `netrx0`,
  `tcpmem`, `cmds`, `bgsave*`, and that `psi10` is there or `psi=off`;
- the probe lines show `err=0` and a plausible `conn_ms`, `p50` and `burst_ms`;
- a minute later, `~/perf/redis-sample.log` and the `latency-*.log` files exist and
  `~/perf/cron.log` is empty (cron on Amazon Linux 2023 is cronie, which is not
  installed by default);
- before `cpu-squeeze.sh on`: `cpu-squeeze.sh <redis-ssh-host> status` finds the NIC's
  IRQs (`ens5-Tx-Rx-*`, `ena-mgmnt@*`) and the `rx-*/rps_cpus` files, and
  `systemctl show -p AllowedCPUs system.slice` works (systemd with cgroup v2).
