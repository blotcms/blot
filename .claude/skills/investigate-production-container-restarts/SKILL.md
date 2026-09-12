---
name: investigate-production-container-restarts
description: Work out why the blot-container-{blue,green,yellow} Docker containers from the most recent production deployment have restarted — distinguishing a normal deploy-triggered restart from a crash (V8 heap OOM, Linux cgroup OOM kill, or the deploy script's own health-check rollback). Use when asked to investigate container restarts, figure out why a container went down, or check on the health of the latest deploy.
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
out which of three things happened: (1) the deploy script's own
create/replace cycle (expected, once per container per deploy), (2) the
deploy's automated rollback after a failed health check, or (3) an
unplanned crash (in-process V8 OOM, or a Linux-level OOM kill) that Docker
silently recovered from and which would otherwise go unnoticed.

**Always confirm with the user before running anything against
production**, and stick to read-only commands (log tailing, `docker
inspect`, `docker logs`, read-only `redis-cli`) unless a state-changing
action has been explicitly authorized.

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

Two distinct causes look identical in `docker ps` but require different
evidence and point to different fixes. Check both — don't stop at the
first one that seems plausible.

### V8/Node heap OOM (in-process crash, not a Linux OOM kill)

```bash
ssh blot "docker logs <container> --since <before-crash> --until <after-crash> 2>&1 | grep -B5 'FATAL ERROR\|JavaScript heap out of memory'"
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

## 6. Local reproduction

Prefer reproducing locally over experimenting on production once a
candidate site/request is identified: clone of a real large blog through
the normal dev stack (`npm start` / docker-compose), `toxiproxy` to
simulate realistic server↔redis latency, and `ab` (ApacheBench) for
concurrent load. A large, growing gap between `ab`'s wall-clock mean and
the server's own per-request logged timings under concurrency signals
requests queueing behind event-loop-blocking work rather than running in
parallel — the same signature as the process eventually exhausting memory
under sustained load.

## 7. Report

This skill only identifies **why** the restart happened — it doesn't fix
the underlying app bug unless separately asked to. If the cause is a
genuine app-level issue (heap growth on a specific render path, a specific
site's pathological page), file or update a GitHub issue with: which
container(s), how many restarts, the failure mode (V8 OOM / cgroup OOM /
health-check rollback), the triggering request(s) if found, and whether it
correlates with a specific site (cross-check against
`node-response-time-review` if so). If the cause is deploy tooling itself
(a bad health check, a rollback that left a stale container running),
that's a `scripts/deploy/` issue, not an app-code one — say so explicitly
so it doesn't get miscategorized.
