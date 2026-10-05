# render-probe

Renders blog pages on production in a throwaway container with extra
instrumentation, to diagnose a render that stalls or crashes an app container
(e.g. yellow restarting on an uncached `/archives`) without risking the live
ones.

```
npm run render-probe -- https://www.example.com/archives
npm run render-probe -- https://www.example.com/archives --concurrency 4 --repeat 3
npm run render-probe -- --stats https://www.example.com
npm run render-probe -- --replay access.log-20261002.gz --from 2026-10-01T09:58:00 --to 2026-10-01T10:03:30
npm run render-probe -- https://www.example.com/archives --release <older commit> --heap-snapshot
npm run render-probe -- --help
```

## How it runs

`index.js` (run locally) handles the probe's own arguments and hands the
container to the launcher shared by the production probes,
[`scripts/probe/run.js`](../probe/run.js). That:

- uses yellow's current image (`--release <sha>` for another; it says first if
  that image isn't on the host and would be pulled, which can take GBs);
- refuses to start unless the host has more memory available than the
  container's limit plus 512MB, and free disk for the output of at least twice
  the heap limit plus 1GB (a heap snapshot is about as large as the heap);
- shows the `docker create` it is about to run and asks for confirmation;
- uploads `probe.js` and the shared `scripts/probe/args.js` and
  `instrument.js` to `/tmp/blot-probe/render-probe/<run>/` on the host, a
  directory only the ssh user can enter (only its `out/` subdirectory, which
  is mounted into the container, is writable by the container's user);
- runs them in a container of that image with the production env file, the
  data directory mounted **read-only**, the access logs mounted read-only at
  `/logs`, no published port, no airlock network, its own memory limit and one
  CPU, and `--restart no`;
- prints the container's exit code and whether the kernel OOM-killed it, then
  removes it, copies `out/` to `./data/render-probe/<run>/` and deletes the
  host copy - only once the copy has succeeded; otherwise it says where the
  output was left. That happens however the run ends: on Ctrl-C it kills the
  container first (a second Ctrl-C is ignored, a third abandons the cleanup
  and prints what was left behind). If the ssh connection drops, the
  container keeps running on the host until the cleanup removes it.

The output holds customer content (and a heap snapshot, secrets from
memory): delete it when done.

## What it records

`probe.js` mounts the real `blog` router on 127.0.0.1 and sends it requests
with the right `Host` header. Its process-local caches start cold, like a
freshly restarted container. Output:

- `samples.ndjson`: heap, RSS, external memory, event loop delay, inflight
  requests and Redis command count every 100ms.
- `phases.ndjson`: duration of each step that cost something (catalog fetch,
  `augmentEntries`, `prepareCacheValue`, `cloneDeep`, each retriever,
  `loadView`, Mustache), keyed by request, plus GC pauses over 100ms. A step
  has `soleRequestHeapDeltaMB` only when no other request was in flight,
  since otherwise the heap change isn't its own.
- `requests.ndjson`: status, bytes, duration, Redis commands and reply size
  per request.
- `summary.json`: peaks, GC totals, Redis commands by type with reply sizes,
  LRU cache footprints, heap spaces.
- On a V8 out-of-memory crash, a Node report (`report.*.json`, without env
  vars) with the JS stack. With `--heap-snapshot`, a `.heapsnapshot` taken
  near the heap limit (open it in Chrome DevTools > Memory). This can be as
  large as the heap; the default 3g memory limit leaves room to write it.

The three `.ndjson` files are written as the probe runs, so they survive a
crash. Redis commands are counted from node-redis' diagnostics channels, which
cover pipelines and `MULTI`/`EXEC` (counted together under `MULTI`) but not
replies served from the client-side cache.

## Load on production

Rendering only reads from Redis, but a cold render of a large blog is heavy
on the shared, live Redis: `--concurrency` and a replay's `--max-inflight` are
capped at 8 requests in flight, and `--speed` at 4x. Keep replays short.
`--replay` reads a file from `/var/instance-ssd/logs` (gzipped rotated logs
too) and fails if no requests to yellow started in the window.

The container's `CONTAINER_NAME` is `blot-probe-render-probe`, so its log lines
are tagged `[render-probe]` and `config.master` is false. The probe never loads
`app/setup.js`, so it starts no scheduled jobs and never flushes the
render-time metric to Redis: its renders stay out of the daily numbers.

## Crash reports from the app containers

The app containers write their own Node report on a fatal error to
`/var/www/blot/data/node-reports/<container>/` on the host. Nothing prunes that
directory.
