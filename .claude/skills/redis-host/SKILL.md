---
name: redis-host
description: Look after Blot's production Redis (redis6 on the combined production host, set up with config/redis/ and moved with the host cycle, config/host/cycle.sh): triage a "Redis host:" alert email from app/scheduler/check-redis-host.js (failed background save, Redis refused writes - OOM/MISCONF/NOREPLICAS, other Redis errors, rejected connections, Redis restarted or switched host, slow Redis commands, TCP memory, memory over 90% of maxmemory, stale sample, stale backup or offsite backup, maxmemory unset) or a problem in the Redis or Server line of the daily email (resize now, last save failed, backup overdue, no sample, backup disk full); resize the host (a host cycle); rehearse or run disaster recovery; or check Redis health. Holds the procedure and the guardrails (ask before every production command, drill hosts, teardown, no rollback to a recent host) and points into config/redis/README.md for the steps. Appends a short entry to this skill's incident log. Use when the user pastes or forwards one of these alerts, or asks to resize, drill, restore or check the Redis host.
---

# Redis host

Production Redis (`redis6` 6.2) runs on the one production host, an
m6gd.xlarge on Amazon Linux 2023, together with both units. The units reach it
over a Unix socket (`/run/blot/redis/redis.sock`); there is no separate Redis
host and no floating IP. `config/redis/README.md` describes the Redis setup,
backups and alerts and holds the steps for promoting a replica and disaster
recovery; replacing or resizing the host is the host cycle
(`config/host/cycle.sh`, `config/host/README.md`). This skill does not repeat
them: it says which README section to use, which
read-only checks to propose for each alert, how to read them, and what must
never be done without asking.

SSH alias: `blot` is the production host (`ec2-user`, key-only). The old
`redis` alias no longer exists.

Related: `investigate-production-container-restarts` (a Redis stall shows up
there as `[LOCK COMPROMISED]` restarts; its section on the Redis host has the
TCP memory background) and `investigate-slow-upstream-responses`.

## Rules

1. **Ask the operator before EVERY production command**: `ssh blot`, `docker exec`, `docker logs`, and any AWS call that changes
   something (launch, terminate, assign an address, modify an attribute, write
   to S3). Read-only commands too. State the exact command. An approval
   covers that command only, not the next one, not "the same kind of thing",
   and not what other skills auto-approve. Read-only AWS `describe-*` / `ls`
   calls are fine without asking, but say what you ran.
2. **Use `cycle.sh --drill` for any throwaway host** (a rehearsal, a
   restore test, a promotion practice). A drill host is tagged `BlotDrill=true`
   and can never upload backups, so it cannot add to the
   production ones.
3. **Tear down by explicit instance ID only**, never with a filter-based
   terminate. Immediately before, re-check that instance's `BlotDrill` tag and
   that it is not a production instance (not the one holding the production
   Elastic IP). Production instances have termination
   protection; if a terminate is refused for that reason, stop and ask rather
   than lifting it.
4. **Roll back only while the old host still replicates from the new one.**
   `promote.sh` with the hosts swapped needs that, and writes made on the new
   host since come back too, so decide quickly. Otherwise go forward to a
   fresh host.
5. **No deploys or proxy restarts around a promotion.** Always `--dry-run`
   first, and not at :00 or :30 (backups, sync validation) or 01:00 UTC
   (wildcard certificate renewal).
6. **Private details stay out of public issues and PRs.** Instance IDs, public
   IPs, account IDs, key names: they go in the gitignored `data/` directory
   (the repo is public). Private IPs already in the README are fine.
7. **The shell is zsh, which does not word-split variables.** Run snippets that
   loop over several IDs under `bash`.
8. Do not run anything that writes to the live Redis (`CONFIG SET`, `BGSAVE`,
   `readonly.sh`, `SLOWLOG RESET`) or changes the host (`sysctl -w`,
   `bootstrap.sh`) on your own initiative. Propose it, with the exact command
   and what it will do, after the read-only checks say it is needed.

## What triggers this

`app/scheduler/check-redis-host.js` runs every 5 minutes on the master and
emails `REDIS_HOST_ALERT` with the subject `Redis host: <summary>` (template
`app/helper/email/admin/REDIS_HOST_ALERT.txt`). Each condition is emailed
once when it starts and once when it clears. Conditions are states; events
come from `app/scheduler/redis-host-events.js`, which compares Redis's
counters with the ones seen at the previous check (a gap over 15 minutes
starts a new baseline, so a long outage does not produce a flood).

| Alert title | Trigger |
| --- | --- |
| TCP memory nearing tcp_mem[1] | the host's sample `mem` is at 50% of `tcp_mem[1]` (clears at 45%) |
| TCP memory pressure | `TCPMemoryPressures` rose on the same host since the last sample |
| TCP memory sample stale | no new sample for 20 minutes (judged only if the previous check also read Redis within 11 minutes) |
| Redis backup stale | the time in `blot:redis-host:backup` is over 3 hours old (two missed hourly runs), or the value can't be read; a missing key is quiet |
| Offsite Redis backup stale | the same for `blot:redis-host:offsite` at 50 hours (two missed daily runs); S3 backups may be fine. Look at `~/backup.log`, the `blot-b2` profile, B2 and `/etc/blot-redis/offsite-bucket` |
| Redis memory nearing maxmemory | `used_memory` at 90% of `maxmemory` (clears at 85%); `noeviction`, so writes fail at the limit |
| maxmemory not set | `maxmemory` is 0 on a host marked active by `/etc/blot-redis/active` |
| Redis background save failing | `rdb_last_bgsave_status` is not `ok` (`stop-writes-on-bgsave-error yes`) |
| Redis refused writes (OOM, MISCONF) | any new `OOM`, `MISCONF` or `NOREPLICAS` error (emailed at most hourly) |
| Redis errors | 100 or more new errors of one other type (`READONLY`, `WRONGTYPE`, `ERR`...) within one 5-minute check |
| Redis rejected connections | `rejected_connections` rose: Redis was at `maxclients` |
| Redis restarted or switched host | uptime went backwards, or `run_id` or version changed |
| Slow Redis commands | slowlog entries of 50ms or more (Redis records from 10ms) |

The **daily email** has one line, from `app/scheduler/daily/redis-server.js`:
`Redis: memory 27% (resize in ~58 days, 8 GB free), saved 3m ago, backed up 30m ago, offsite 9h ago`
`Server: disk 21% (19 GB free), RAM 75% available (12 GB)`
These need action:

| In the line | Meaning |
| --- | --- |
| **resize now** | memory is at 80% of `maxmemory` or more |
| `no maxmemory set` | as the alert above |
| **last save failed** / `save not reported` / `never saved` | background save problem |
| **last backup Xh ago, overdue** / **no backup recorded** | no upload for over 2 hours (backups are hourly) |
| `no sample from the host` / `sample Nm old` / `disk not reported` (Server line) | the host's 5-minute sample is missing or old |
| **/backups not mounted** / **backup disk N% full** | the instance store holding local backup copies |
| `Redis: unavailable (...)` (and `Server: unavailable`) | Redis itself is down; `/redis-health` covers that, treat it as an outage |

To print the current report without sending an email, the README has
`NODE_PATH=app node app/scheduler/check-redis-host.js`; on production that
runs inside an app container, so it is a production command (ask first).

## Method

1. Read the alert (or the daily line) and find its row above. Note the time,
   and whether a promotion, deploy or resize happened near it. Check the
   incident log below for the same pattern.
2. Propose the read-only checks for that alert (next section), one command at
   a time, and get approval for each (rule 1).
3. Read the result against the notes. Say what you think happened and how
   sure you are before proposing a fix.
4. A fix is either a README procedure (resize, disaster recovery, bootstrap
   to re-apply config) or a one-off change on the host. Propose it with the
   exact commands and wait for a yes. After it, repeat the check that showed
   the problem to confirm it cleared.
5. Report to the operator in chat, then append an entry to the incident log.

## Triage per alert

Host checks run as `ssh blot '<command>'` (use `ssh -n` when the command
does not read stdin). `redis6-cli` needs no auth.

### Background save failing / `last save failed`

```
ssh blot 'redis6-cli INFO persistence'
ssh blot 'sudo tail -n 100 /var/log/redis6/redis6.log'
ssh blot 'df -h / /backups; free -m; sysctl vm.overcommit_memory'
```

- `rdb_last_bgsave_status:err`, with `rdb_last_bgsave_time_sec` and
  `latest_fork_usec` (in `INFO stats`) for how long the last good one took.
- The log names the reason. `Can't save in background: fork: Cannot allocate
  memory` is overcommit (`vm.overcommit_memory` must be 1; `bootstrap.sh`
  sets it) or too little free RAM for the fork's copy-on-write: memory is too
  high for the host, so see the resize section. `No space left on device` or
  `Write error saving DB on disk` is the root disk (`/var/lib/redis6`).
- Redis keeps taking writes (`stop-writes-on-bgsave-error no`), but nothing new
  reaches disk until a save succeeds, so it is urgent. A host not yet bootstrapped
  with that setting refuses writes (`MISCONF`) instead.
  Redis retries on its own `save` schedule; a manual `BGSAVE` is a write
  to the host, so propose it separately once the cause is fixed.
- On a disk problem, find what filled it (`sudo du -xh --max-depth=2 / | sort -h | tail`)
  before deleting anything, and ask before deleting.

### Redis refused writes (OOM, MISCONF, NOREPLICAS)

```
ssh blot 'redis6-cli INFO errorstats'
ssh blot 'redis6-cli INFO memory | grep -E "^(used_memory_human|maxmemory_human|mem_fragmentation_ratio):"'
ssh blot 'redis6-cli CONFIG GET min-replicas-to-write'
```

- `OOM`: memory reached `maxmemory`. Treat as the memory alert below, but
  urgent: the app is serving 503s.
- `MISCONF`: the failed-save section above.
- `NOREPLICAS`: `min-replicas-to-write` is not 0. It should be 0; `readonly.sh`
  sets 99 and may have been left on after a freeze or a rehearsal
  (`readonly.sh <host> off` undoes it, which is a write: propose it).
- The app side: `Error saving file in database` lines, and
  `[LOCK COMPROMISED]` restarts, in the containers' logs (see below).

### Other Redis errors

`INFO errorstats` for the type and count. `READONLY` is expected for a moment
during a promotion; outside one, clients are talking to a replica: check
`redis6-cli ROLE` on the host, and which host has
`/etc/blot-redis/active`. `WRONGTYPE` or `ERR` in bulk is an app bug:
find the error text and the calling code in the containers' logs and fix it
in the app. An error the app swallows leaves no log line: compare
`INFO commandstats`' `failed_calls` per command, and `total_connections_received`,
30 seconds apart, to see which command fails and whether each new connection
brings errors with it (see the 2026-11-03 entry).

### Rejected connections

```
ssh blot 'redis6-cli INFO clients'
ssh blot 'redis6-cli CLIENT LIST | grep -o " addr=[0-9.]*" | sort | uniq -c | sort -rn | head'
```

`connected_clients` against `maxclients`. Units connect over the Unix socket,
so their addresses show as the socket path or empty; the per-address counts
show which client (a unit, the proxy, a script, a replica) is leaking
connections. Fixing
that means restarting or fixing the client, which is a production change to
propose, not to do.

### Restarted or switched host

Expected after a promotion, a host cycle or a Redis restart (the host itself is not rebooted until there are several hosts). If none, check:

```
ssh blot 'uptime; redis6-cli INFO server | grep -E "^(run_id|uptime_in_seconds|redis_version):"'
ssh blot 'sudo journalctl -u redis6 --since "2 hours ago" | tail -n 50'
ssh blot 'sudo dmesg | grep -i -E "oom|killed process" | tail'
ssh blot 'sudo tail -n 100 /var/log/redis6/redis6.log'
```

An OOM kill (dmesg, journald) means memory: the resize section. A reboot
means look at why. Data written since `rdb_last_save_time` is lost after a
crash (`save` policy and the hourly backups are all there is: no AOF), so
check `redis6-cli INFO persistence` and, in the app, whether sync validation
needs a run. Expect `[LOCK COMPROMISED]` restarts in the app containers from
the outage itself.

### Slow Redis commands

```
ssh blot 'redis6-cli SLOWLOG GET 20'
ssh blot 'redis6-cli INFO stats | grep latest_fork_usec'
```

Each entry has the command, its first arguments, the duration in
microseconds and the client address. One slow command blocks everything
behind it on Redis's single thread, so the usual suspects are a big reply
(`SMEMBERS`/`LRANGE`/`MGET` over huge values), a Lua script, `KEYS` or an
unbounded `SCAN`, or a fork stall at the :00 backup (compare the time with
`latest_fork_usec`). Find the calling code by
grepping the repo for the command and the key pattern, then fix it in the
app. Do not `SLOWLOG RESET` before the entries are recorded in the report.

### TCP memory (nearing tcp_mem[1], pressure, sample)

```
ssh blot 'tail -n 30 ~/tcpmem.log'
ssh blot 'grep TCP: /proc/net/sockstat; cat /proc/sys/net/ipv4/tcp_mem'
ssh blot 'nstat -az TcpExtTCPMemoryPressures TcpExtTCPMemoryPressuresChrono TcpExtPruneCalled TcpExtTCPRcvQDrop'
```

`mem` and `tcp_mem` are pages. Healthy use is dozens of sockets with empty
queues and a count far below `tcp_mem[1]`. A count that keeps rising with few
sockets is leaked kernel accounting (the old host's problem in September and
October 2026, behind the incident log's first entry): the fix is a new host
(resize section), not tuning. A count that rises with many real sockets
(`ss -tm`) is a client leak or burst: find the client. The stopgap for a
leak, `sudo sysctl -w net.ipv4.tcp_mem=...` above the count, is lost on
reboot and is a host change to propose. Background and the burst test are in
`investigate-production-container-restarts`.

### Memory over 90% of maxmemory / `resize now`

```
ssh blot 'tail -n 20 ~/redis-mem.log'
ssh blot 'redis6-cli INFO memory | grep -E "^(used_memory_human|used_memory_peak_human|maxmemory_human|mem_fragmentation_ratio):"'
ssh blot 'redis6-cli INFO keyspace'
```

Compare with the daily email's projection: steady growth is the normal
path to a resize, a sudden jump is something writing a lot (a sync, a
runaway job) and is worth finding first. `maxmemory` is about 70% of RAM, so
it is the headroom for the save's copy-on-write that is being used up.
Fix: **README, "Increasing the Redis server size"**, then the guardrails
below. The daily email flags 80% and the alert 90%: raising `maxmemory`
needs no planning while the host has RAM to spare (the Server line). Avoid `--bigkeys`, `--scan` or `DEBUG` commands on the live
master (one CPU); never `KEYS`. `MEMORY USAGE <key>` is cheap for a suspect key.

### Stale sample / `no sample from the Redis host`

The sample is written to Redis by `bin/tcpmem-log.sh` on the host, only if
the host is the master and accepts writes.

```
ssh blot 'tail -n 5 ~/tcpmem.log; cat /etc/cron.d/blot-redis; systemctl is-active crond'
ssh blot 'redis6-cli ROLE | head -n 1; ls /etc/blot-redis/active'
```

Right after a promotion the new host needs one or two 5-minute runs. If
`ROLE` is not `master` or Redis refuses the write (`OOM`, `MISCONF`,
frozen), it is that problem, not cron. If cron is dead or the file is gone,
`REDIS_MAXMEMORY=6gb config/redis/bootstrap.sh blot` re-applies it (propose,
do not run). Always pass `REDIS_MAXMEMORY` on the production host: without it
setup takes 70% of RAM and raises Redis into the units' share.

### maxmemory not set

`ssh blot 'redis6-cli CONFIG GET maxmemory; cat /etc/redis6/blot-memory.conf'`.
Fix: `REDIS_MAXMEMORY=6gb config/redis/bootstrap.sh blot` (the shared host's
limit; never leave it out, or setup takes 70% of RAM), which writes the file and applies it
with `CONFIG SET` without a restart (propose it; the README, "Running
bootstrap on a live host").

### Backup overdue / no backup recorded / backup disk

```
ssh blot 'tail -n 20 ~/backup.log; ls -l /etc/blot-redis; cat /etc/cron.d/blot-redis'
ssh blot 'df -h /backups; findmnt /backups; systemctl status blot-instance-store --no-pager | head'
aws s3 ls s3://blot-redis-backups/hourly/ | tail -n 3  # hourly/ keeps 1 day, daily/ 7, weekly/ 30 (lifecycle rules)
```

`bin/backup.sh` exits quietly unless the host is a master that accepts
writes, `/etc/blot-redis/active` exists, and `/etc/blot-redis/drill` does not
exist. A missing marker after a promotion
or restore, or a stray `drill` marker, explains a silent gap; `backup.log` and
the newest S3 key give the last good upload. `/backups` is the NVMe instance
store: it is wiped when the instance stops and keeps the 10 newest local
copies, so "not mounted" means the mount service failed, and "full" means
pruning stopped.

### What the app is seeing (`ssh blot`)

Useful with any of the above, to see whether clients are affected:

```
ssh blot 'docker logs --since 1h blot-green 2>&1 | grep -c "\[LOCK COMPROMISED\]"'
ssh blot 'docker logs --since 1h blot-green 2>&1 | grep -E "\[LOCK\] slow heartbeat|Error saving file in database" | tail -n 20'
ssh blot 'grep -o "st=[0-9][0-9.]*" /var/instance-ssd/logs/access.log | tail -n 20000 | cut -d= -f2 | sort -n | awk "{a[NR]=\$1} END {print \"p50\", a[int(NR*.5)], \"p95\", a[int(NR*.95)]}"'
```

Run the first two for each unit that matters (blot-blue, blot-green).
`st=` is nginx's upstream time in seconds; most blog renders take about 10ms,
so a p95 well past 100ms during the alert, or `slow heartbeat` lines with a
large `roundTrip`, means clients felt it. Container logs only go back to the
last deploy. For a window rather than the last 20000 lines, `grep` the log for
the minute prefix first. `investigate-slow-upstream-responses` takes it from
there.

## Resize

**README, "Increasing the Redis server size"**: first try raising `maxmemory`
(Redis shares the host's RAM with the units); if the host is too small, that is
a host cycle onto a bigger type in the same family (`config/host/README.md`,
"Host cycle"; `cycle.sh` runs `promote.sh` at `switch`). Guardrails on top
of the rules:

- Every `cycle.sh` phase with `--dry-run` first, and show the operator the
  plan each prints.
- Keep instance IDs and public IPs out of chat that will be pasted into an
  issue; put them in `data/`.
- After the promotion, check `/redis-health`, the app containers' restart
  counts, and that the next hourly backup arrives from the new host.
- The old host stays up about a day after `settle`, replicating from the new
  one, then `cycle.sh finish` terminates it by instance ID (rule 3).
  It is not a rollback target after the first minutes (rule 4).

## Disaster recovery and drills

**README, "Disaster recovery"**: pick the newest backup with
`restore.sh <host> list`, restore onto a new host, check it, turn on backups, check the app. In
production the whole recovery is `cycle.sh restore` (`config/host/README.md`,
"Recovery"). To rehearse the Redis part, run steps 1-3 on a
`cycle.sh --drill` host (tagged, never uploads), write down the commands for
steps 5-6 against the drill host without running them, time each step, and tear
the host down by instance ID (rule 3). A drill is still a production-account
action: launch and terminate each need an explicit yes. Add the timings to
the incident log.

## Report

Report to the operator in chat: which alert, the evidence, the cause, what was
changed or what to change. If something needs follow-up work, add a compact
line to the root `TODO` under "Redis host follow-ups". Then append to the
incident log.

## Incident log

Read this first: a repeated alert changes the diagnosis. Newest entries last.

**Privacy: this file is committed to a public repo.** No customer
information (domains, handles, blog IDs, post titles), no instance IDs, public
IPs, account IDs or key names, and no userbase or infra size numbers beyond
what the README already states. Give UTC times so a future agent can find the
same moment in the logs while they last.

Entry template:

```
### <date> — <alert or task>
- Trigger / evidence: …
- Cause: …
- Fix / outcome: …
- Follow-up: …
```

### 2026-10-08 — host replaced (blotcms/blot#2041)

- Trigger / evidence: the TCP memory alert on the previous host (kernel
  accounting leaked past `tcp_mem`, bursts to Redis dropped, `[LOCK
  COMPROMISED]` crashes on 26 Sep and 6 Oct). A fix-probe on the blog from
  the 6 Oct crash showed the shared connection waiting up to 4002ms with 98
  retransmits.
- Fix / outcome: a bootstrapped single-CPU host replaced it by cutover at
  18:18 UTC: writes unavailable 2.85s (FAILOVER 40ms,
  `assign-private-ip-addresses` 1.8s), no folder lock lost. The TCP memory
  alert cleared. The same fix-probe on the new host: worst shared-connection
  wait 188ms, 0 retransmits. A disaster-recovery restore drill
  (`launch.sh --drill`, newest backup) took 2m31s for the full production dataset.
- Follow-up: the previous host was terminated. Remaining items are under
  "Redis host follow-ups" in `TODO`.

### 2026-10-08 — "Slow Redis commands": BGSAVE 84ms (false positive)

- Trigger / evidence: one entry, `BGSAVE` 84ms at 21:00Z, the hourly backup's
  own save (`backup.sh` saves right before each upload). Redis logs a
  `BGSAVE` with the time it took to fork, ~60-85ms on the current host.
- Cause: expected; not a slow command.
- Fix / outcome: `BGSAVE`/`BGREWRITEAOF` are now only reported at
  `FORK_ALERT_US` (500ms) or more (`app/scheduler/redis-host-events.js`).
- Follow-up: none. A fork over 500ms is worth a look (dataset growth, memory
  pressure on the host).

### 2026-10-08 — restore drill 2, with a cutover dry run

- Trigger / evidence: rehearsal after the cleanup of `cutover.sh` (#2079).
  `hourly/2026-10-08-hour-21` (the first backup saved right before upload)
  restored onto a `--drill` host in 2m25s; key count within 0.001% of live.
- Then made it a replica of the live master (~67s; a ~63ms fork and ~33s save
  on the master, no visible effect, no `[LOCK]` lines) and ran
  `cutover.sh --dry-run`: every check passed, the drill-host warning showed,
  plan steps 1-6, rollback command without `--allow-unbootstrapped`.
- Fix / outcome: README "Disaster recovery" now stops the refresh timer
  around a hand-made IP move and removes the drill marker if a drill host
  goes live. Drill host terminated after.

### 2026-10-09 — "Slow Redis commands": PSYNC 63ms, BGSAVE 250ms (false positives)

- Trigger / evidence: email at 03:02Z listing `BGSAVE` 250ms at 22:00Z and
  `PSYNC` 63ms at 21:06Z, both held back by the 6-hour limit since the
  21:00Z BGSAVE email.
- Cause: the PSYNC was restore drill 2's replica attaching (the fork for its
  full sync). The BGSAVE was the hourly backup, detected at about 22:05Z by
  code deployed before the `FORK_ALERT_US` filter went live (deploy
  22:09-22:13Z); held-back events aren't re-filtered.
- Fix / outcome: `PSYNC`/`SYNC` added to `FORK_COMMANDS`, so a replica's full
  sync is only reported at 500ms or more.
- Follow-up: the 250ms fork is ~3x the usual 60-85ms, an hour after the
  drill's full sync; under the threshold, so the 500ms alert will catch a
  trend.

### 2026-11-01 — restore drill 3, from Backblaze B2

- Trigger / evidence: first real restore from the offsite bucket (#2261),
  with `launch.sh --drill --from latest --offsite`.
- Result: passed in 33 minutes, nearly all of it streaming the file from the
  operator's Mac, so a B2 restore's time is the operator's upload speed. The
  dump passed the RDB check and loaded; `backup.sh` skipped on the drill
  marker. The read key's profile also needs a `~/.aws/config` block with the B2
  endpoint.
- Also proved on a real host: Redis at `oom_score_adj` -900, a BGSAVE child at
  1000, `CPUWeight` 1000, and the Unix socket bound after a systemd restart.
- Caveat: the launch template attaches an instance profile, so the host had
  one, but the offsite path never ran `aws` there.
- Follow-up: `launch.sh --drill` hosts get termination protection from the
  launch template, so a teardown is refused until it is lifted. Presigned
  downloads are in `TODO`.

### 2026-11-03 — "Redis errors: ERR" alert (at least 100 within 5 minutes)

- Trigger / evidence: alert at 12:57 UTC. `errorstat_ERR` was rising about
  0.5/s, with no `ERR` lines in the units' logs. Over 30s at 13:04 UTC,
  `errorstat_ERR` rose by 4, `cmdstat_client` `failed_calls` by 4 and
  `cmdstat_hello` (new node-redis RESP3 connections) by 2. Over Redis's
  uptime, `cmdstat_client` `failed_calls` equalled `errorstat_ERR`.
- Cause: node-redis sends `CLIENT SETINFO LIB-VER` and `LIB-NAME` in every
  connection's handshake and ignores the reply. Redis 6.2 has no `SETINFO`
  (it came in 7.2), so each new node-redis connection added two `ERR`. A burst
  of new connections crossed the alert's threshold. It was not the
  client-side cache's `CLIENT CACHING YES`: no failures were left over once
  the handshakes were accounted for.
- Fix / outcome: `disableClientInfo: true` for every client
  (`app/models/redis.js` `connectionOptions`).
- The burst: a verification script run as one `docker exec … node scripts/…`
  process per blog, from about 12:37 to 13:10 UTC. Each process opened its own
  Redis connection and exited after a few seconds. Run per-item loops inside
  one Node process instead. The other new connections (16 per 30s at 13:04
  UTC) sent no `HELLO` and caused no errors.
- Follow-up: if the alert returns, look at `CLIENT LIST` for short-lived
  clients, and ask whoever is running scripts in the units.

### 2026-11-06 — host cycle onto a 30 GB root disk (blotcms/blot#2552)

- Trigger / evidence: the data volume was retired (#2258, #2259), so the host
  was moved to a new one with a 30 GB root disk and the newest AL2023 image,
  by the volume-free `cycle.sh` after two drills.
- Fix / outcome: 06:06-06:35 UTC. launch 306s, replicate 94s, app (third
  try: `units.sh` refused a detached worktree, then one ssh connect timed out
  from the Mac), switch 172s, settle about 2.5 min. FAILOVER took 114ms with
  the replica 856 bytes behind. Writes were frozen 110s (41s in the drill);
  the per-step timing isn't logged. Probes of the site and a test blog every
  2s through switch and the first normal deploy afterwards: no failures.
  `finish` ran the same day at the operator's request; the old host is
  terminated, so rollback is now a restore from backups.
- Follow-up: under "Host cycle follow-ups" in `TODO` (the first offsite sync
  from the new host, timing the freeze, host keys at launch).
