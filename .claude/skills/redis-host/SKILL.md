---
name: redis-host
description: Look after Blot's production Redis host (its own EC2 instance, built and operated with config/redis/): triage a "Redis host:" alert email from app/scheduler/check-redis-host.js (failed background save, Redis refused writes - OOM/MISCONF/NOREPLICAS, other Redis errors, rejected connections, Redis restarted or switched host, slow Redis commands, TCP memory, memory over 80% of maxmemory, stale sample, maxmemory unset) or a problem in the Redis line of the daily email (resize now, last save failed, backup overdue, no sample, backup disk full); resize the host; rehearse or run disaster recovery; or check Redis health. Holds the procedure and the guardrails (ask before every production command, drill hosts, teardown, no rollback to a recent host) and points into config/redis/README.md for the steps. Appends a short entry to this skill's incident log. Use when the user pastes or forwards one of these alerts, or asks to resize, drill, restore or check the Redis host.
---

# Redis host

Production Redis is one host, built by `config/redis/` and reached by the
app containers, the proxy and the cert scripts at a floating private IP
(`BLOT_REDIS_HOST`). `config/redis/README.md` describes the setup and holds
the steps for building a host, cutting over, resizing and disaster recovery.
This skill does not repeat them: it says which README section to use, which
read-only checks to propose for each alert, how to read them, and what must
never be done without asking.

SSH aliases: `redis` is the Redis host (`ec2-user`, port 22, key-only),
`blot` is the app host.

Related: `investigate-production-container-restarts` (a Redis stall shows up
there as `[LOCK COMPROMISED]` restarts; its section on the Redis host has the
TCP memory background) and `investigate-slow-upstream-responses`.

## Rules

1. **Ask the operator before EVERY production command**: `ssh redis`,
   `ssh blot`, `docker exec`, `docker logs`, and any AWS call that changes
   something (launch, terminate, assign an address, modify an attribute, write
   to S3). Read-only commands too. State the exact command. An approval
   covers that command only, not the next one, not "the same kind of thing",
   and not what other skills auto-approve. Read-only AWS `describe-*` / `ls`
   calls are fine without asking, but say what you ran.
2. **Use `launch.sh --drill` for any throwaway host** (a rehearsal, a
   restore test, a cutover practice). A drill host is tagged `BlotDrill=true`
   and can never upload backups, so it cannot overwrite or prune the
   production ones.
3. **Tear down by explicit instance ID only**, never with a filter-based
   terminate. Immediately before, re-check that instance's `BlotDrill` tag and
   that it is not a production instance (not the one holding the floating IP
   or serving `BLOT_REDIS_HOST`). Production instances have termination
   protection; if a terminate is refused for that reason, stop and ask rather
   than lifting it.
4. **Never roll back to a host whose interface held the floating IP
   recently.** The VPC keeps delivering to the other interface for seconds
   (README, "Timings and rollback"), which costs `[LOCK COMPROMISED]`
   restarts. Go forward to a fresh host instead.
5. **No deploys or proxy restarts around a cutover.** Only cut over in the
   windows `cutover.sh` allows, and always `--dry-run` first.
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
| Redis memory nearing maxmemory | `used_memory` at 80% of `maxmemory` (clears at 75%); `noeviction`, so writes fail at the limit |
| maxmemory not set | `maxmemory` is 0 on a host marked active by `/etc/blot-redis/floating-ip` |
| Redis background save failing, writes will be refused | `rdb_last_bgsave_status` is not `ok` (`stop-writes-on-bgsave-error yes`) |
| Redis refused writes (OOM, MISCONF) | any new `OOM`, `MISCONF` or `NOREPLICAS` error (emailed at most hourly) |
| Redis errors | 100 or more new errors of one other type (`READONLY`, `WRONGTYPE`, `ERR`...) within one 5-minute check |
| Redis rejected connections | `rejected_connections` rose: Redis was at `maxclients` |
| Redis restarted or switched host | uptime went backwards, or `run_id` or version changed |
| Slow Redis commands | slowlog entries of 50ms or more (Redis records from 10ms) |

The **daily email** has one line, from `app/scheduler/daily/redis-server.js`:
`**Redis:** memory 27% (resize in ~47 days), disk 21% (19 GB free), saved 3m ago, backed up 30m ago.`
These need action:

| In the line | Meaning |
| --- | --- |
| **resize now** | memory is at 70% of `maxmemory` or more |
| `no maxmemory set` | as the alert above |
| **last save failed** / `save not reported` / `never saved` | background save problem |
| **last backup Xh ago, overdue** / **no backup recorded** | no upload for over 2 hours (backups are hourly) |
| `no sample from the Redis host` / `sample Nm old` / `disk not reported` | the host's 5-minute sample is missing or old |
| **/backups not mounted** / **backup disk N% full** | the instance store holding local backup copies |
| `Redis: unavailable (...)` | Redis itself is down; `/redis-health` covers that, treat it as an outage |

To print the current report without sending an email, the README has
`NODE_PATH=app node app/scheduler/check-redis-host.js`; on production that
runs inside an app container, so it is a production command (ask first).

## Method

1. Read the alert (or the daily line) and find its row above. Note the time,
   and whether a cutover, deploy or resize happened near it. Check the
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

Host checks run as `ssh redis '<command>'` (use `ssh -n` when the command
does not read stdin). `redis6-cli` needs no auth.

### Background save failing / `last save failed`

```
ssh redis 'redis6-cli INFO persistence'
ssh redis 'sudo tail -n 100 /var/log/redis6/redis6.log'
ssh redis 'df -h / /backups; free -m; sysctl vm.overcommit_memory'
```

- `rdb_last_bgsave_status:err`, with `rdb_last_bgsave_time_sec` and
  `latest_fork_usec` (in `INFO stats`) for how long the last good one took.
- The log names the reason. `Can't save in background: fork: Cannot allocate
  memory` is overcommit (`vm.overcommit_memory` must be 1; `bootstrap.sh`
  sets it) or too little free RAM for the fork's copy-on-write: memory is too
  high for the host, so see the resize section. `No space left on device` or
  `Write error saving DB on disk` is the root disk (`/var/lib/redis6`).
- Writes are refused (`MISCONF`) until a save succeeds, so it is urgent.
  Redis retries on its own `save` schedule; a manual `BGSAVE` is a write
  to the host, so propose it separately once the cause is fixed.
- On a disk problem, find what filled it (`sudo du -xh --max-depth=2 / | sort -h | tail`)
  before deleting anything, and ask before deleting.

### Redis refused writes (OOM, MISCONF, NOREPLICAS)

```
ssh redis 'redis6-cli INFO errorstats'
ssh redis 'redis6-cli INFO memory | grep -E "^(used_memory_human|maxmemory_human|mem_fragmentation_ratio):"'
ssh redis 'redis6-cli CONFIG GET min-replicas-to-write'
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
during a cutover; outside one, clients are talking to a replica: check
`redis6-cli ROLE` on the host `BLOT_REDIS_HOST` points at, and which host has
`/etc/blot-redis/floating-ip`. `WRONGTYPE` or `ERR` in bulk is an app bug:
find the error text and the calling code in the containers' logs and fix it
in the app.

### Rejected connections

```
ssh redis 'redis6-cli INFO clients'
ssh redis 'redis6-cli CLIENT LIST | grep -o " addr=[0-9.]*" | sort | uniq -c | sort -rn | head'
```

`connected_clients` against `maxclients`. The per-address counts show which
host (app container host, proxy, a script) is leaking connections. Fixing
that means restarting or fixing the client, which is a production change to
propose, not to do.

### Restarted or switched host

Expected after a cutover, a resize or a planned reboot. If none, check:

```
ssh redis 'uptime; redis6-cli INFO server | grep -E "^(run_id|uptime_in_seconds|redis_version):"'
ssh redis 'sudo journalctl -u redis6 --since "2 hours ago" | tail -n 50'
ssh redis 'sudo dmesg | grep -i -E "oom|killed process" | tail'
ssh redis 'sudo tail -n 100 /var/log/redis6/redis6.log'
```

An OOM kill (dmesg, journald) means memory: the resize section. A reboot
means look at why. Data written since `rdb_last_save_time` is lost after a
crash (`save` policy and the hourly backups are all there is: no AOF), so
check `redis6-cli INFO persistence` and, in the app, whether sync validation
needs a run. Expect `[LOCK COMPROMISED]` restarts in the app containers from
the outage itself.

### Slow Redis commands

```
ssh redis 'redis6-cli SLOWLOG GET 20'
ssh redis 'redis6-cli INFO stats | grep latest_fork_usec'
ssh redis 'ls ~/perf/*.log 2>/dev/null && tail -n 20 ~/perf/redis-sample.log'
```

Each entry has the command, its first arguments, the duration in
microseconds and the client address. One slow command blocks everything
behind it on Redis's single thread, so the usual suspects are a big reply
(`SMEMBERS`/`LRANGE`/`MGET` over huge values), a Lua script, `KEYS` or an
unbounded `SCAN`, or a fork stall at the :00 backup (compare the time with
`latest_fork_usec` and the `~/perf/redis-sample.log` BGSAVE columns, if the
collectors from `config/redis/perf/` are installed). Find the calling code by
grepping the repo for the command and the key pattern, then fix it in the
app. Do not `SLOWLOG RESET` before the entries are recorded in the report.

### TCP memory (nearing tcp_mem[1], pressure, sample)

```
ssh redis 'tail -n 30 ~/tcpmem.log'
ssh redis 'grep TCP: /proc/net/sockstat; cat /proc/sys/net/ipv4/tcp_mem'
ssh redis 'nstat -az TcpExtTCPMemoryPressures TcpExtTCPMemoryPressuresChrono TcpExtPruneCalled TcpExtTCPRcvQDrop'
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

### Memory over 80% of maxmemory / `resize now`

```
ssh redis 'tail -n 20 ~/redis-mem.log'
ssh redis 'redis6-cli INFO memory | grep -E "^(used_memory_human|used_memory_peak_human|maxmemory_human|mem_fragmentation_ratio):"'
ssh redis 'redis6-cli INFO keyspace'
```

Compare with the daily email's projection: steady growth is the normal
path to a resize, a sudden jump is something writing a lot (a sync, a
runaway job) and is worth finding first. `maxmemory` is about 70% of RAM, so
it is the headroom for the save's copy-on-write that is being used up.
Fix: **README, "Increasing the Redis server size"**, then the guardrails
below. The daily email warns at 70% so there are days to plan; the 80% alert
means do it now. Avoid `--bigkeys`, `--scan` or `DEBUG` commands on the live
master (one CPU); never `KEYS`. `MEMORY USAGE <key>` is cheap for a suspect key.

### Stale sample / `no sample from the Redis host`

The sample is written to Redis by `bin/tcpmem-log.sh` on the host, only if
the host is the master and accepts writes.

```
ssh redis 'tail -n 5 ~/tcpmem.log; cat /etc/cron.d/blot-redis; systemctl is-active crond'
ssh redis 'redis6-cli ROLE | head -n 1; cat /etc/blot-redis/floating-ip'
```

Right after a cutover the new host needs one or two 5-minute runs. If
`ROLE` is not `master` or Redis refuses the write (`OOM`, `MISCONF`,
frozen), it is that problem, not cron. If cron is dead or the file is gone,
`config/redis/bootstrap.sh redis` re-applies it (propose, do not run).

### maxmemory not set

`ssh redis 'redis6-cli CONFIG GET maxmemory; cat /etc/redis6/blot-memory.conf'`.
Fix: `config/redis/bootstrap.sh redis`, which writes the file and applies it
with `CONFIG SET` without a restart (propose it; the README, "Running
bootstrap on a live host").

### Backup overdue / no backup recorded / backup disk

```
ssh redis 'tail -n 20 ~/backup.log; ls -l /etc/blot-redis; cat /etc/cron.d/blot-redis'
ssh redis 'df -h /backups; findmnt /backups; systemctl status blot-instance-store --no-pager | head'
aws s3 ls s3://blot-redis-backups/hourly/ | tail -n 3
```

`bin/backup.sh` exits quietly unless the host is a master that accepts
writes, `/etc/blot-redis/floating-ip` exists and its address is on the host,
and `/etc/blot-redis/drill` does not exist. A missing marker after a cutover
or restore, or a stray `drill` marker, explains a silent gap; `backup.log` and
the newest S3 key give the last good upload. `/backups` is the NVMe instance
store: it is wiped when the instance stops and keeps the 10 newest local
copies, so "not mounted" means the mount service failed, and "full" means
pruning stopped.

### What the app is seeing (`ssh blot`)

Useful with any of the above, to see whether clients are affected:

```
ssh blot 'docker logs --since 1h blot-container-green 2>&1 | grep -c "\[LOCK COMPROMISED\]"'
ssh blot 'docker logs --since 1h blot-container-green 2>&1 | grep -E "\[LOCK\] slow heartbeat|Error saving file in database" | tail -n 20'
ssh blot 'grep -o "st=[0-9][0-9.]*" /var/instance-ssd/logs/access.log | tail -n 20000 | cut -d= -f2 | sort -n | awk "{a[NR]=\$1} END {print \"p50\", a[int(NR*.5)], \"p95\", a[int(NR*.95)]}"'
```

Run the first two for each container that matters (blue, green, yellow).
`st=` is nginx's upstream time in seconds; most blog renders take about 10ms,
so a p95 well past 100ms during the alert, or `slow heartbeat` lines with a
large `roundTrip`, means clients felt it. Container logs only go back to the
last deploy. For a window rather than the last 20000 lines, `grep` the log for
the minute prefix first. `investigate-slow-upstream-responses` takes it from
there.

## Resize

**README, "Increasing the Redis server size"** (launch a replica of the live
master on a bigger type in the same family with `--from replica:<primary
private IP>`, check it, `cutover.sh` in an allowed window). Guardrails on top
of the rules:

- `launch.sh --dry-run` and `cutover.sh --dry-run` first, and show the
  operator the plan each prints.
- The replica must follow the old host's **primary** private IP, not the
  floating IP.
- Keep instance IDs and public IPs out of chat that will be pasted into an
  issue; put them in `data/`.
- After the cutover, check `/redis-health`, the app containers' restart
  counts, and that the next hourly backup arrives from the new host.
- The old host stays up a few days, replicating from the new one, then is
  terminated by instance ID (rule 3). It is not a rollback target after the
  first minutes (rule 4).

## Disaster recovery and drills

**README, "Disaster recovery"**: pick the newest backup with
`launch.sh --list`, restore onto a new host, check it, move the floating IP,
turn on backups, check the app. To rehearse it, run steps 1-3 with
`launch.sh --drill` (tagged, never uploads), write down the commands for
steps 4-5 against the drill host without running them, time each step, and tear
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
