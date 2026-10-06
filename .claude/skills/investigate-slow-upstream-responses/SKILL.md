---
name: investigate-slow-upstream-responses
description: Scan the production openresty access log (/var/instance-ssd/logs/access.log) for requests with slow upstream response times (st=, the time the node containers took to answer), triage and rank them while setting aside routes that are slow by design (SSE, long polls, webhooks), then investigate the top candidates with the app logs and the render-probe script to tell a regularly pathological request from one that queued behind something else. Appends a short entry to this skill's findings log. Use when asked to look into slow upstream times, slow st= values, slow requests in the access log, or to re-run the slow upstream review.
---

# Investigate slow upstream responses

**Bar: 100ms.** Any page request whose `st=` is over 100ms is bad. Most
blog renders take ~10ms, so 100ms+ means either the request is expensive or
it waited behind one that was.

Related: `node-response-time-review` ranks sites by app-side render time over
a window. This skill starts from nginx's view (`st=`), separates queueing from
real cost, and goes on to find out *why* with the render probe.

## Production access

Host `ssh blot`. The operator has OK'd **read-only** commands for this skill
(log reads, `docker logs`, `docker ps`, `redis-cli` read commands on specific
keys, never `KEYS`). Nothing that writes, restarts or deletes.

`npm run render-probe` starts a throwaway container on the host (data
mounted read-only, own memory/CPU limit) and is part of this skill. Run one
probe at a time, keep `--concurrency` low, and pass `--yes` only once the
operator has agreed to probing in this session. Its output in
`./data/render-probe/<run>/` holds customer content: delete it when done.

## Background

Log format (`config/openresty/conf/http.conf`, `access_log_format`):

```
[06/Oct/2026:09:28:17 +0000] <request_id> <status> <request_time> <req>:<bytes> <url>  cache=<HIT|MISS|-> ip=… st=<upstream_response_time> lrs=… up=<addr> ua=…
```

- `st=-`: nginx cache hit, no upstream. `st=0.088, 0.049` / `up=a, b`: a
  retry on a second upstream (sum them). Ports: `8090` yellow (blogs),
  `8089` green (blot.im POSTs, webhooks), `8088` blue (dashboard and blot.im
  GETs; also the **backup** for blogs, so blog requests on blue mean yellow
  was down or failing, usually around a deploy).
- `<request_id>` is passed to node as `X-Request-ID`, so the same id appears
  in the container's log (`app/request-logger.js`):
  ```
  [time] [yellow] <id> <url> GET
  [time] [yellow] <id> +12ms <req.log step>
  [time] [yellow] <id> <status> <duration-s> <url> elu=<0..1> slowest=+<ms>ms:"<step>"
  ```
  `st − duration` ≈ time the request queued before the app's middleware
  ran. `elu` is event-loop utilisation over the request: ~1 means the
  process was CPU-bound (this request *or another*), ~0 means it was
  waiting on I/O (Redis, disk). `slowest=` is the longest gap between
  the request's `req.log` steps and the step that ended it (only on
  requests that log steps, mostly blog renders; `(response finished)` means
  the gap was after the last step). A request that never finishes logs
  `<id> Connection closed by client <url>` instead.
- `[EVENT LOOP] lag max=…` lines (`app/helper/eventLoopMonitor.js`) mark
  windows where the loop blocked >500ms.
- Container logs are lost on every deploy. Check `docker ps` uptime first:
  the access log usually covers more time than the app logs do.

Routes that are slow by design: the triage script sets these aside, so
glance at the counts but don't investigate unless something looks off:

| Route | Why |
|---|---|
| `blot.im/sites/*/status`, `…/import/status` | dashboard SSE (`helper/sse`) |
| `webhooks.blot.im/connect` | webhook relay SSE (`app/clients/webhooks.js`) |
| `*/draft/stream/*` | draft preview SSE |
| `preview-of-*/__blot/preview/reload` | template preview SSE |
| `blot.im/clients/{google-drive,dropbox}/webhook*` | sync work done inline |
| `blot.im/clients/git/*`, `stripe/paypal-webhook`, rebuild, import, OAuth | real work inline |

Add to `LONG_LIVED` / `INHERENT` in `triage.js` when you meet a new one.

## Method

Use cheaper subagents (`model: "sonnet"`) for per-candidate digging. Keep
triage, render probes and the write-up in the main agent. Probes run one at
a time on the host, so don't let parallel subagents start them.

### 1. Pull the log and check the window

```bash
S=<scratchpad>
ssh blot "docker ps --format '{{.Names}}\t{{.Status}}'"
ssh blot "ls -la /var/instance-ssd/logs/"
ssh blot "gzip -c /var/instance-ssd/logs/access.log" > $S/access.log.gz
```

(`gzip: file size changed while zipping` is harmless: the log is live.) Add
the rotated `access.log-YYYYMMDD` for a longer window. Note when the app
containers started; requests before then can only be judged from nginx.

### 2. Triage

```bash
T=.claude/skills/investigate-slow-upstream-responses/triage.js
node $T $S/access.log.gz                       # whole window
node $T $S/access.log.gz --since 08:42:00      # since containers started
node $T $S/access.log.gz --detail <host>       # one host's slow requests + ids
node $T $S/access.log.gz --at 04:10:30         # everything in flight around a moment
```

It prints:

- per-upstream counts, the share of slow page requests, and an st histogram;
- **set aside**: long-lived/inherent routes with counts and median;
- **stall clusters**: ≥3 slow page requests overlapping on one upstream
  (start = log time − st). The *suspect* is the longest. A cluster across
  many hosts that all finish within the same second is one blocked event
  loop: the suspect is the cause, the rest are victims. A cluster on one
  host is often a crawler burst on that host;
- **URL groups** (host + route with dates/ids collapsed), ranked by total
  time over the bar. `slow/all` says how often that route is slow. `own`
  counts slow requests that were alone or the cluster suspect (likely their
  own cost). The rest overlapped something slower (likely queued);
- **hosts** with ≥20 requests, by share of slow requests.

Pick candidates: top URL groups with high `own`, hosts with a high slow
share, and every cluster suspect over ~1s. Drop anything that only appears
as a victim. Treat requests on **blue for a blog host** and anything in
the first few minutes after a container start as deploy noise unless it
continues afterwards. Check the root `TODO` ("Fix performance bugs on
various sites") and the findings log below for already-known sites.

### 3. App-side cross-check

Join the slow requests to the app's response lines by request id:

```bash
J=.claude/skills/investigate-slow-upstream-responses/join-app-log.js
ssh blot "for c in blue green yellow; do docker logs blot-container-\$c 2>&1; done | grep -E '^\[[^]]+\] \[[a-z-]+\] [0-9a-f]{32} ([0-9]{3} [0-9.]+ |Connection closed)'" > $S/app.log
node $J $S/access.log.gz $S/app.log [--host <host>]
```

It splits slow requests into *mostly queued* (`st − app > st/2`) and
*mostly own time*, then into CPU-bound (`elu ≥ 0.8`) and I/O-bound
(`elu < 0.3`), counts the most common `slowest=` steps, and lists the
slowest requests with st / app / queued / elu / slowest step. Only requests
since the containers started can join; the access log copy must overlap
that (pull it fresh if a deploy happened since).

For one request id, every step it logged:

```bash
ssh blot "docker logs --timestamps blot-container-yellow 2>&1 | grep <id>"
```

All of a host's completion lines, slowest first:

```bash
ssh blot "docker logs blot-container-yellow 2>&1 | grep -E '^\[[^]]+\] \[yellow\] [0-9a-f]{32} [0-9]{3} [0-9.]+ https?://<host>' | awk '{print \$5, \$6, \$8, \$7}' | sort -k2 -rn | head"
```

Read it as:

- **duration ≈ st, elu ~1, every request** → the render itself is
  CPU-heavy. Regularly pathological: probe it (step 4).
- **duration ≈ st, elu low** → waiting on I/O: Redis round trips (count
  them with the probe), a slow Redis command (`redis-cli SLOWLOG GET 20`),
  disk, or an outbound fetch.
- **duration ≪ st** → it queued. Use `--at <time>` to find what was
  running on that upstream and investigate *that* instead.
- **slow only on first hit, fast after** → cold cache (process-local LRUs
  start empty after each deploy). Only a concern if the site is slow on
  cold renders by an unusual margin.
- **only crawlers, only uncached long-tail URLs** (404s, `/page/N`,
  `/search`) → still a real cost, but the fix may be cheaper 404s or
  caching rather than faster renders.

Brief for a sonnet subagent (one per candidate, run in parallel, background).
Make it self-contained: the context above (host, containers, deploy time, log
formats, what `elu` means, read-only rule, no probes), the candidate's slow
lines with ids from `--detail`, its `slow/all`, and ask for: app duration/elu
and `st − duration` per id, the code path for that route with file:line,
whether cost scales with entry count, regular vs one-off, ranked likely causes
with confidence, under ~400 words.

### 4. Render probe

For blog hosts only (the probe mounts the blog router; blot.im pages can't
be probed, so read their code instead). See `scripts/render-probe/README.md`.

```bash
npm run render-probe -- https://<host>/<path> [more urls] --repeat 3 --verbose --cpu-prof --yes
npm run render-probe -- --stats https://<host>        # catalog size, read timings, Redis diagnostics
npm run render-probe -- --replay access.log --from 2026-10-06T04:10:20 --to 2026-10-06T04:10:35   # reproduce a stall window
```

Summarise the output (per-request time, Redis commands/bytes, costliest
phases, and the CPU profile's top self-time functions):

```bash
node .claude/skills/investigate-slow-upstream-responses/probe-summary.js data/render-probe/<run>
```

- `--repeat 3`: first render is cold (like just after a deploy), repeats are
  warm. Slow every time = regularly pathological. Slow once = cold cache.
- `--verbose` / `phases.ndjson`: which step costs what (catalog fetch,
  `augmentEntries`, `prepareCacheValue`, `cloneDeep`, retrievers,
  `loadView`, Mustache). Phases of concurrent async work overlap, so
  read the slowest one, not the sum. Lots of Redis commands with a low
  loop delay = I/O-bound (round trips); `mustache`/`cloneDeep` dominant
  with a large page = CPU-bound template.
- `requests.ndjson`: Redis commands and reply bytes per request: lots of
  round trips → I/O, huge replies → catalog size.
- `--cpu-prof`: `.cpuprofile` in the output dir (open in Chrome DevTools >
  Performance, or summarise self-time by function with a short node script).
- `--replay` a stall cluster's window to check that the suspect really
  causes it: if the replay's own timings show the same pile-up, it's the
  burst (often one site's CPU-heavy renders × a parallel crawler), not
  something outside the app. The replay caps in-flight requests at 8 and
  skips the rest, so a burst wider than that won't fully reproduce. Read
  "skipped N request(s)" and the per-request times rather than expecting
  the production numbers.
- A fast probe for a URL that's slow in production → it isn't the request
  itself. Look for what else was running (`--at`, `[EVENT LOOP]`, Redis
  SLOWLOG, a sync or validation run in green's log at that time).

Delete `./data/render-probe/<run>/` when done.

### 5. Report and log

Report to the operator in chat (domains and ids are fine there): window,
headline numbers, each candidate's classification with evidence, and what
to fix. Don't change code unless asked. If a site or route needs work, add a
compact line to the root `TODO` (under "Fix performance bugs on various
sites" for a site), or note it for a PR.

Then append an entry to the findings log below and update the Method or
`triage.js` if you learned something. Clean up scratch copies of the log.

## Findings log

Read this first: a known slow site or route changes the triage. Newest last.

**Privacy: this file is committed to the repo, so entries must contain no
customer information.** No domains, handles, blog IDs, paths that name
content, post titles or template names. Describe sites generically ("a blog
with several thousand entries on a heavy custom template", "the site already
listed in TODO under 'Fix performance bugs on various sites'"). Give UTC
timestamps and nginx request ids (random tokens) so a future agent can
re-find the requests in the logs. Keep out userbase/infra size numbers;
percentages and per-request timings are fine.

Entry template:

```
### <date> — window <HH:MM>–<HH:MM> UTC
- Headline: <share of upstream requests over 100ms>, <what dominated>
- <candidate>: <classification> — <evidence: st, app duration, elu, probe> — <cause / next step>
- Set aside / noise: …
- Follow-up: …
```

### 2026-10-06 — window 03:34–09:29 UTC (skill created)

- Headline: ~4% of upstream requests had st ≥ 100ms, and ~1/3 of the slow
  page requests fell in stall clusters. One blog (the one listed in TODO
  under "Fix performance bugs on various sites" as needing speed) had 46%
  of its requests slow and was the suspect of the largest cluster
  (04:10:25–04:10:32, yellow, 40 requests / 15 hosts, suspect
  `50ab38e0a873d503affbbf68491d3223`): a crawler fetched ~20 of its pages
  at once, each costing 0.2–0.6s of CPU (app elu ≈ 0.99 on every render,
  probe warm render ~600ms, mostly Mustache on a ~650KB page). A replay of
  that window (in-flight capped at 8) peaked at 336ms loop delay, so the
  production pile-up needed the wider burst.
- A second blog's entry pages take ~3.8s on every render, warm or cold
  (probe: ~1000 Redis commands / 18MB per render in the entry-loading
  phase, loop delay ~11ms, so I/O-bound). Not root-caused yet.
- A third blog's `/search` costs 0.5–0.8s warm (the `search_results` local
  reads ~10MB from Redis per query), and its 404s cost 100–400ms. The 404s
  are crawler hits on `…/null` links the template emits.
- blot.im `/questions/*` pages: 250–750ms, elu 0.2–0.4 (I/O), including
  302s from `/questions/:id/edit`. Not root-caused yet.
- The probe's verbose log showed the folder-link pass doing a folder
  lookup for each `mailto:` link (`No file found in folder: mailto:…`).
- Set aside: every Google Drive `changes.watch` webhook in the window
  ended 499 at ~8.8s. `app/clients/google-drive/routes/site.js` awaits
  the sync before replying, so Google hangs up each time (unlike the Dropbox
  webhook, which acks first).
- Follow-up: added the `slowest=` field to the response log line and
  `join-app-log.js`. TODO lines added for the Google Drive webhook ack and
  `mailto:` lookups.

