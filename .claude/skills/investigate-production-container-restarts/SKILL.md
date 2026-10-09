---
name: investigate-production-container-restarts
description: Work out why the blot-container-{blue,green,yellow} Docker containers from the most recent production deployment have restarted — distinguishing a normal deploy-triggered restart from a crash (V8 heap OOM, Linux cgroup OOM kill, a lost sync folder lock - `[LOCK COMPROMISED]` - from a stalled Redis connection, or the deploy script's own health-check rollback). Use when asked to investigate container restarts, figure out why a container went down, or check on the health of the latest deploy.
---

# Investigate production container restarts

Blot runs three named app containers plus an airlock sidecar (see
`scripts/deploy/constants.js`):

- `blot-container-blue` (port 8088, `siteConfig`) — failover, sites+blogs
- `blot-container-green` (port 8089, `siteConfig`) — dashboard/brochure/sync
- `blot-container-yellow` (port 8090, `blogsConfig`) — preview+published blogs
- `blot-airlock` — separate egress sidecar, not part of blue/green/yellow

Every container runs `docker create --restart unless-stopped`, so **Docker
itself will silently restart a crashed container** — a restart is not
inherently a deploy problem, but it's also not nothing. This skill works
out which of three things happened:

1. the deploy script's own create/replace cycle (expected, once per
   container per deploy);
2. the deploy's automated rollback after a failed health check;
3. an unplanned crash that Docker silently recovered from and which would
   otherwise go unnoticed: an in-process V8 OOM, a Linux-level OOM kill, or
   the deliberate crash when a sync loses its folder lock.

**Confirm with the user before running anything against production
that isn't on the auto-approved list below**, and stick to read-only
commands (log tailing, `docker inspect`, `docker logs`, read-only
`redis-cli`) unless a state-changing action has been explicitly
authorized.

**Auto-approved (no confirmation needed)** — these read-only commands
over `ssh blot` may be run without asking:

- `docker ps -a` and `docker inspect` on blot-container-{blue,green,yellow}
  (release ID, `CreatedAt`, `RestartCount`, `OOMKilled`, exit code)
- `cat ~/docker-health-check.log`
- `dmesg | grep -i kill` (or the `kills` helper)
- `docker logs <container>` with `--since`/`--until`, including grepping
  for `FATAL ERROR` / `JavaScript heap out of memory`
- `grep <request-id> /var/instance-ssd/logs/access.log` (or the `req`
  helper) to find the triggering request

Anything else (state-changing commands, restarts, deploys) still needs
explicit user approval.

## 1. Identify the most recent deployment

SSH host is `blot`. Each container is created with
`-e BLOT_RELEASE_ID=<commitHash>` (`scripts/deploy/util/generateDockerCommand.js`)
and named `${REGISTRY_URL}:${commitHash}` as its image tag — this is the
ground truth for "what deploy is currently running," independent of
`docker ps`'s uptime column:

```bash
ssh blot "docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.CreatedAt}}\t{{.Image}}'"
ssh blot "for c in blot-container-blue blot-container-green blot-container-yellow; do echo \$c:; docker inspect \$c --format '{{range .Config.Env}}{{println .}}{{end}}' | grep BLOT_RELEASE_ID; done"
```

Cross-reference the commit hash against GitHub to see what actually
shipped and when:

```bash
git log -1 <commit-hash>
gh run list --workflow=deploy.yml --limit 5
```

If all three containers share the same `BLOT_RELEASE_ID` and a similar
`CreatedAt`, that confirms they were replaced together by one deploy run —
the baseline for "expected" restarts. A container with a **different**
(older) `BLOT_RELEASE_ID` than its siblings, or a much older `CreatedAt`,
means it didn't pick up the latest deploy — that's itself worth explaining
(failed health check → rollback left it on the old image; see step 4).

## 2. `docker ps -a` — is this actually a restart worth investigating?

```bash
ssh blot "docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.CreatedAt}}'"
```

- `Up <a few minutes>` with a `CreatedAt` matching the deploy time = the
  container was recreated by the deploy itself (`docker create` + `docker
  start`, per container, once). Normal, expected, not a crash.
- `Up <a few minutes>` with a `CreatedAt` from **before** the deploy = the
  same container object restarted (not recreated) after the deploy
  finished — this is Docker's `--restart unless-stopped` kicking in after
  a crash, not part of the deploy process. This is the case worth digging
  into.
- `RestartCount` > 0 confirms Docker has restarted this container object at
  least once since it was created:

```bash
ssh blot "docker inspect <container> --format 'OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}} StartedAt={{.State.StartedAt}} RestartCount={{.RestartCount}}'"
```

`OOMKilled` only reflects a Docker/cgroup-level OOM kill of the whole
container — it's usually `false` even when the Node process inside hit
*its own* `--max-old-space-size` limit and crashed on its own. Don't treat
`OOMKilled=false` as ruling out memory as the cause; check both failure
modes in step 3 regardless.

Also check the auto-restart health-check script's own log, which is a
separate mechanism from Docker's `--restart` policy — it appends a line
every time it force-restarts a container it decided was unhealthy:

```bash
ssh blot "cat ~/docker-health-check.log"
```

## 3. Determine the failure mode

Several distinct causes look identical in `docker ps` but require
different evidence and point to different fixes. Check each — don't stop
at the first one that seems plausible. Grep the end of the previous run's
log for `FATAL ERROR`, `LOCK COMPROMISED` and `Unhandled 'error' event`
before anything else; between them they cover most crashes.

### V8/Node heap OOM (in-process crash, not a Linux OOM kill)

```bash
ssh blot "docker logs <container> --since <before-crash> --until <after-crash> 2>&1 | grep -B5 'FATAL ERROR\|JavaScript heap out of memory'"
```

Each fatal error also leaves a Node report (JS stack at the crash, heap
spaces, resource usage; env vars excluded) in
`/var/www/blot/data/node-reports/<container>/report.*.json` on the host.
These outlive log rotation and container recreation, so check them first
(`ls`/`cat` there is read-only):

```bash
ssh blot "ls -lt /var/www/blot/data/node-reports/<container>/ | head"
```

If the container's logs have rotated past the crash, openresty still has
it: the error log shows a burst of `connect() failed` / `prematurely
closed` errors to the container's port in the crash second, and the
access log shows the in-flight requests that died with it (502, long
request time, `up=127.0.0.1:<port>`):

```bash
ssh blot "zcat -f /var/instance-ssd/logs/error.log* | grep ':8090' | grep -c 'connect() failed'"
```

The crash timestamp is the `Starting server on ...` line that follows the
restart in the container's log (search forward from there to find where
the *previous* run's log ends). Almost always an application-code problem
— something holding too much data in memory for a single request — not a
memory-limit tuning issue on its own. Read the log lines immediately
before the crash to find the triggering request (step 5).

### Linux cgroup OOM kill

```bash
ssh blot "dmesg | grep -i kill"
# or the bashrc helper, which converts dmesg's boot-relative timestamps to human-readable and filters for OOM events:
ssh blot "kills"
```

Confirm the killed process was actually `node` (not esbuild, chromium, or
something unrelated sharing the container), and compare its `anon-rss` at
kill time against the container's configured memory limit:

```bash
ssh blot "docker inspect <container> --format '{{.HostConfig.Memory}}'"
```

### Lost sync folder lock (`[LOCK COMPROMISED]`, `ECOMPROMISED`)

A sync holds a per-blog folder lock in Redis (`app/sync/lock.js`): 10s TTL,
renewed by a heartbeat `EXTEND` every 3s over the **shared** node-redis
connection. If a renewal doesn't reach Redis before the TTL lapses, the
lock is lost, and `app/sync/index.js` deliberately rethrows so the process
stops writing. It mostly hits green (which runs the syncs).

**Signature:**

- the log ends with one or more `[LOCK COMPROMISED] {...}` diagnostics
  blocks, then `Error: Lock was lost: blog:<id>:folder-lock` thrown from
  `app/sync/index.js` with `code: 'ECOMPROMISED'`;
- `OOMKilled=false`, and no Node report (it isn't a fatal V8 error);
- several blogs' locks are usually lost in the same second, because they
  share the stalled connection.

```bash
ssh blot "docker logs <container> --since <before> --until <after> 2>&1 | grep -n 'LOCK COMPROMISED\|Lock was lost\|\[LOCK\]'"
```

**Read the heartbeat instrumentation:**

- **`[LOCK] slow heartbeat <key> tickDelay=… roundTrip=…`** is logged for
  any renewal over 500ms.
  - `tickDelay` near 0 means the timer fired on time, so the event loop
    isn't to blame.
  - A large `roundTrip` means the `EXTEND` sat on the connection.
  - Several heartbeats finishing in the same second, with round trips
    3s apart (e.g. 7.5s / 4.5s / 1.5s), means the connection was blocked
    for the whole span.
- **`[LOCK] stall probe … probePing=… idle=… qbuf=… omem=…`** comes from a
  separate Redis connection, taken while a heartbeat is outstanding.
  - A fast `probePing` means Redis itself is responsive.
  - Empty `qbuf`/`omem` on the shared connection means nothing is backed
    up inside Redis either.
  - Both together mean the bytes are stuck in a TCP send queue or in
    flight.
- **`elu=` on request lines** is event loop utilisation over *that
  request's* lifetime.
  - A `/health` request that took several seconds with `elu=0.02` proves
    the process sat idle, waiting on I/O.
  - `elu=1.00` on a 1ms request means nothing.
- **Baseline:** count `slow heartbeat` lines per container since the
  deploy. A healthy connection logs few or none.

**Then check the Redis host.** That's where the root cause has been, and
it is a separate production host (`ssh redis`), so confirm with the user
first:

```bash
ssh -n redis 'grep TCP: /proc/net/sockstat; cat /proc/sys/net/ipv4/tcp_mem; nstat -az TcpExtTCPMemoryPressures TcpExtTCPMemoryPressuresChrono TcpExtPruneCalled TcpExtTCPRcvQDrop TcpExtTCPOFODrop'
ssh -n redis 'tail -20 ~/tcpmem.log'   # 5-minute history, from /etc/cron.d/blot-redis (config/redis/bin/tcpmem-log.sh)
```

- `sockstat`'s `mem` and `tcp_mem` are both in pages. Once `mem` is above
  `tcp_mem[1]`, the kernel is in memory-pressure mode. Above `tcp_mem[2]`,
  each socket may buffer only a minimal amount of incoming data.
- In that state small commands get through, but any pipelined burst sent
  to Redis is dropped and re-sent with growing back-off, which stalls
  everything queued behind it for seconds.
- `TCPMemoryPressures` counts entries into pressure since boot.
- `TCPMemoryPressuresChrono` is the total time spent in it, in ms. It is
  only added to when the kernel *leaves* pressure, so a value that jumps
  dates the episode.
- Prune and drop counters that rise with each burst confirm the receiving
  side is discarding data.

From 25 Sep to 6 Oct 2026 the Redis host's kernel TCP memory accounting
had leaked past `tcp_mem[2]`, with near-empty real socket buffers.
- That caused the green crashes of 26 Sep and 6 Oct, and green's routine
  1–2s slow heartbeats.
- Raising `net.ipv4.tcp_mem` above the leaked count (runtime `sysctl -w`)
  cleared it at once.
- The real fix is a kernel update and reboot. See blotcms/blot#2041 for
  the full write-up, the checklist, and whether that has happened yet.

**To confirm a stall is on the network path, and not in the app:**

- **Burst test.** Pipe about 250KB of inline `PING\r\n` into one fresh TCP
  connection to Redis, and time the replies. The Redis address is
  `BLOT_REDIS_HOST` in a container's env; send the script over stdin as
  `ssh blot 'script=$(cat); node -e "$script"' < burst.js`.
  - Run it from the app host, then from a throwaway container on
    `blotnet`, e.g. `docker run --rm -i --network blotnet --entrypoint node
    <a live container's image> -`.
  - A healthy path answers in tens of milliseconds with 0 retransmits.
    Compare `RetransSegs` in `/proc/net/snmp` before and after.
  - While the leak was active it took 2.5–9s, with tens to over a hundred
    retransmits.
  - Check the app host's `ethtool -S eth0 | grep allowance` counters too;
    they rule the AWS network allowance on this side in or out.
- **`npm run fix-probe -- <blog>`** (`scripts/fix-probe/README.md`) runs
  a sync/fix check (default `tag-ghosts`) read-only in a throwaway
  container.
  - It pings the shared connection and a separate control connection
    every 100ms.
  - It samples node-redis' queue, the socket's Node and kernel
    (`/proc/net/tcp`) state, and retransmits.
  - Shared pings stalling while control pings stay fast, with an empty
    Node buffer and a full kernel send queue, means the network path is
    losing data.

Don't respond to this by loosening the lock (a longer TTL, swallowing
`ECOMPROMISED`). The crash is the alarm, and loosening it hides a
Redis-wide problem: every container's large reads and writes are slowed
too.

**Pitfalls** when gathering this evidence:

- Use `ssh -n` (or redirect stdin) for remote commands that might read
  standard input. A `grep` whose file variable came out empty, or a
  backgrounded `node -`, will otherwise hang or silently do nothing.
- `docker run <image tag>` pulls the image if the tag isn't on the host
  under that name, even when the containers are running it.
- Don't write scratch files on the production hosts. Pull the logs locally
  and analyse them there.

### Unhandled 'error' event (e.g. an aborted git request)

The log ends with `throw er; // Unhandled 'error' event` and the name of
the object that emitted it. There is no Node report, `OOMKilled=false`, and
no `LOCK COMPROMISED`. The emitter names the culprit; look for an in-flight
request on that container in the same second (step 5), usually a 502 in the
access log with a long request time.

Example (green, 9 Oct 2026): `Error: aborted` (`ECONNRESET`) emitted "on
Service instance", during a ~580 MB `git push`. Pushover wraps each git
request in an http-duplex `Service` that re-emits the request's errors, and
only some of those objects had a listener. Fixed by
`app/clients/git/guardServices.js` (#2086), which gives every one a listener
and stops its git process.

For the git client, also check:

- every git child now logs one line when it exits:
  `Git: receive-pack|upload-pack <handle> exit=… duration=… rx=… tx=…
  [stderr=…]`. A push that was cut off shows a non-zero exit, a signal or
  git's own error.
- stuck git processes (before #2086 an aborted push left `git-receive-pack`
  and `git index-pack` waiting forever, each `index-pack` holding hundreds of
  MB inside the container's memory limit):

  ```bash
  ssh -n blot "docker exec blot-container-green sh -c 'ps -o pid,etime,rss,args | grep [g]it-'"
  ```

- leftover push staging directories (`objects/tmp_objdir-incoming-*` in the
  bare repos). A push killed by a crash or deploy can't clean up after
  itself; `app/clients/git/sweepQuarantine.js` removes ones older than 24h
  daily at 05:00 on green. Several similar-sized directories in one repo
  mean a user retried a large push that kept failing:

  ```bash
  ssh -n blot "docker exec blot-container-green sh -c 'find /usr/src/app/data/git -mindepth 3 -maxdepth 3 -type d -name \"tmp_objdir-incoming-*\" -exec du -sh {} +'"
  ```

### Neither — the deploy's own health check failed

`scripts/deploy/util/checkHealth.js` polls
`docker inspect --format='{{.State.Health.Status}}'` and then
`curl --fail http://localhost:<port>/health` after each container starts,
with a 3-minute timeout. If this fails, the deploy script's rollback logic
removes/replaces the container rather than leaving a crashed one running —
so a container stuck on an **older** `BLOT_RELEASE_ID` than its siblings
(step 1) is the signature of this path, not a crash at all. Check
`/var/log/deploy-commands.log` for the deploy run's own output around that
time, and the corresponding GitHub Actions run (`gh run view <id> --log`)
for which health check attempt failed and why.

### Known historical false-positive (already fixed, but useful context)

Attaching the airlock network to an *already-running* container reprograms
its routing table and drops in-flight conntrack entries, which used to
crash-restart every container exactly once per deploy with an unhandled
`read ETIMEDOUT` talking to the off-box Redis instance. Fixed by
`docker create` (stopped) → `docker network connect` → `docker start`, so
this shouldn't recur — but if you see a single `ETIMEDOUT`-flavored crash
on every container within seconds of a deploy, this is the pattern to rule
out first before assuming a new regression.

## 4. Since one Node process serves many sites

Blue/green/yellow each run a single Node process serving many sites or
blogs — a slow/blocking render for one site can stall or crash the whole
container, not just that one request (root cause of issue #1806, nashp.com's
uncached `/archives` and `/tagged/<slug>` pages blocking the event loop; see
the `node-response-time-review` skill for identifying which site is
responsible if the crash correlates with heavy traffic to one domain rather
than a memory leak across many).

## 5. Find the triggering request

```bash
ssh blot "docker logs <container> --since <before-crash> --until <crash-time>"
```

gives the log lines right before the crash. Cross-reference the last live
request ID(s) (the 32-char hex string on every log line) against the
openresty access log for the full URL, status, and timing:

```bash
ssh blot "grep <request-id> /var/instance-ssd/logs/access.log"
```

Or use the `req <pattern>` bashrc helper, which greps access/error logs and
all three containers' logs in one shot.

## 6. Reproduce on production in a throwaway container

Once a candidate request is identified, `npm run render-probe -- <url>`
(see `scripts/render-probe/README.md`) renders it in a one-off container of
the same image, data (read-only) and env, with heap, event loop, GC,
Redis and per-render-step timings recorded, and optionally a heap snapshot
near the heap limit. It can't take down the live containers. It runs
against production, so **confirm with the user before each run**. Useful
runs:

- `--stats <url>`: entry count, catalog size and backlink weight, with no
  rendering. Is this blog unusual?
- `<url> --concurrency N`: does memory scale with concurrent cold renders?
- `--replay <access log> --from … --to …`: the real traffic leading up to
  a crash (rotated `.gz` logs work too).
- `--release <older commit>`: does an older release render the same page
  fine? That bisects a regression.

For a crash during sync work rather than a render, `npm run fix-probe`
does the same for a sync/fix check, and `npm run build-probe` does it for
rebuilding a post. See the lost-folder-lock section in step 3.

## 7. Local reproduction

Prefer reproducing locally over experimenting on production once a
candidate site/request is identified: clone of a real large blog through
the normal dev stack (`npm start` / docker-compose), `toxiproxy` to
simulate realistic server↔redis latency, and `ab` (ApacheBench) for
concurrent load. A large, growing gap between `ab`'s wall-clock mean and
the server's own per-request logged timings under concurrency signals
requests queueing behind event-loop-blocking work rather than running in
parallel — the same signature as the process eventually exhausting memory
under sustained load.

## 8. Report

This skill only identifies **why** the restart happened — it doesn't fix
the underlying app bug unless separately asked to. If the cause is a
genuine app-level issue (heap growth on a specific render path, a specific
site's pathological page), file or update a GitHub issue with: which
container(s), how many restarts, the failure mode (V8 OOM / cgroup OOM /
lost folder lock / health-check rollback), the triggering request(s) if found, and whether it
correlates with a specific site (cross-check against
`node-response-time-review` if so). If the cause is deploy tooling itself
(a bad health check, a rollback that left a stale container running),
that's a `scripts/deploy/` issue, not an app-code one — say so explicitly
so it doesn't get miscategorized. Likewise, a lost folder lock traced to
the Redis host or the network path is an infrastructure issue (update
blotcms/blot#2041 or open a new one), not an app-code one.
