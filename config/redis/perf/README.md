# Redis performance: baseline and compare

Small collectors that log how the Redis host and its clients behave once a
minute, and a script that compares two time windows of those logs: before and
after a cutover, a resize or a config change, or a bad hour against a normal
one. They were written for blotcms/blot#2041 (the 8 Oct 2026 move to a new
host). Nothing here is used by the app, and Redis's config is not touched: the
collectors only run `INFO`, `SLOWLOG`, `CONFIG GET` and `LATENCY LATEST`, plus
`PING`.

| File | What it does |
| --- | --- |
| `install.sh <redis-ssh-host> <app-ssh-host> <redis-private-ip>` | Copy the collectors to `~/perf/` on both hosts, check prerequisites, add `# blot-perf` cron lines, run each once. `--uninstall` removes only those lines. |
| `redis-sample.sh` | Redis host, cron every minute: CPU, softirqs, pressure, Redis INFO deltas, BGSAVE, slowlog, TCP memory. |
| `latency-probe.py` | Redis host (to 127.0.0.1) and app host (to the Redis private IP), cron every minute: 50ms PINGs for ~55s plus one 250KB pipelined burst. |
| `fetch.sh <redis-ssh-host> <app-ssh-host>` | Copy the logs to `data/redis-perf/<host>/` and count the app's `[LOCK]` lines per minute. |
| `compare.js` | Side-by-side summary of two time windows. |

Operator scripts run on a Mac (bash 3.2). Set `SSH_OPTS` (for example
`SSH_OPTS="-i ~/key.pem"`) or use `~/.ssh/config` aliases (`redis`, `blot`), as
for the other scripts in `config/redis/`. If the app host needs different
options, `APP_SSH_OPTS` replaces `SSH_OPTS` for it. The hosts need `python3`,
`flock`, `timeout` and `crontab` (cronie: `dnf install cronie && systemctl
enable --now crond`), and `redis6-cli` on the Redis host; `install.sh` checks
before it changes anything.

## Procedure

All times are UTC, in the logs and in `compare.js`.

1. **Install** (from this directory) well before the change you want to
   measure:

   ```
   ./install.sh <redis-ssh-host> <app-ssh-host> <redis-private-ip>
   ```

   It prints one sample line and one probe line from each host. Check them (see
   "On first install"), then after a few minutes look at
   `ssh <host> 'tail -n 3 ~/perf/*.log'`. Cron errors go to `~/perf/cron.log`.
2. **Collect a baseline** of at least 24 hours, so every hour of the day has
   been seen once, including the :00 hourly backups. Avoid deploying meanwhile:
   a deploy replaces the app containers, and their docker logs (the `[LOCK]`
   counts) with them.
3. **Make the change** (or wait for the bad hour). Note the start and end times.
4. **Fetch:** `./fetch.sh <redis-ssh-host> <app-ssh-host>` (`--since 72h` limits
   the docker log window; the default is 168h. Docker durations have no `d`
   unit).
5. **Compare.** `--match-hours` keeps only the baseline minutes whose UTC time
   of day is in the test window's, so both sides cover the same hours (the test
   window may be up to 24h and may wrap past midnight):

   ```
   node compare.js --baseline 2026-10-09T14:00..2026-10-10T14:00 \
     --test 2026-10-10T14:00..16:00 --match-hours
   ```

   A time is `YYYY-MM-DD[THH[:MM]]`; the end of a window may be just `HH[:MM]`.
   Leave a few minutes at each end of the test window for the change to settle.
   It finds the logs under `data/redis-perf/` by itself if one directory there
   has each (`--data`, `--redis-dir` and `--app-dir` override, and are needed
   when several do).
6. **Clean up:** `./install.sh --uninstall <redis-ssh-host> <app-ssh-host>`
   removes the cron lines (other crontab entries are untouched; the old crontab
   is saved as `~/perf/crontab.bak.<ts>`). Logs and scripts stay in `~/perf/`
   until you delete them.

What matters in the output: probe `max` and `gt1000` (the app's sync lock has a
10s TTL renewed every 3s, so seconds-long stalls are what lose it), any
`err` / `reconn`, `[LOCK] slow heartbeat` and `[LOCK COMPROMISED]` counts,
`burst_ms` going from tens of milliseconds to seconds, `tcpmem` jumping rather
than wobbling, and `psi10` / `cpu0_busy` for saturation.

## Load added

Tiny. Each minute: `redis-sample.sh` makes four to five `redis6-cli` calls and
reads a few `/proc` files. Each probe holds one connection and sends ~1,100
`PING`s of 14 bytes, and once a minute one burst of ~17,900 `PING`s (250KB)
whose ~125KB of replies it reads straight back: about 19,000 trivial commands a
minute per probe, with two probes (one local, one from the app host). That is a
few tens of milliseconds of Redis CPU a minute.

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

In the first output, check:

- the `redis-sample.sh` line has numbers (not `x`) for `cpu0_busy`..., `netrx0`,
  `tcpmem`, `cmds`, `bgsave*`, and that `psi10` is there or `psi=off`;
- the probe lines show `err=0` and a plausible `conn_ms`, `p50` and `burst_ms`;
- a minute later, `~/perf/redis-sample.log` and the `latency-*.log` files exist
  and `~/perf/cron.log` is empty (cron on Amazon Linux 2023 is cronie, which is
  not installed by default).
