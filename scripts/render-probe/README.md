# render-probe

Renders blog pages on production in a throwaway container with extra
instrumentation, to diagnose a render that stalls or crashes an app container
(e.g. yellow restarting on an uncached `/archives`) without risking the live
ones.

```
npm run render-probe -- https://www.example.com/archives
npm run render-probe -- https://www.example.com/archives --concurrency 4 --repeat 3
npm run render-probe -- --stats https://www.example.com
npm run render-probe -- --replay access.log-20261002 --from 2026-10-01T09:58:00 --to 2026-10-01T10:03:30
npm run render-probe -- https://www.example.com/archives --release <older commit> --heap-snapshot
npm run render-probe -- --help
```

`index.js` (run locally) reads yellow's current release, checks the host has
enough free memory, shows the `docker run` it is about to start and asks for
confirmation. It copies `probe.js` to the host and runs it in a container of
that image with the production env file, the data directory mounted
**read-only**, the access logs mounted read-only, no published port, no
airlock network, its own memory limit and one CPU. Then it copies the output
to `./data/render-probe/<run>/` and removes the remote copy.

`probe.js` mounts the real `blog` router on 127.0.0.1 and sends it requests
with the right `Host` header. Its process-local caches start cold, like a
freshly restarted container. Output:

- `samples.ndjson`: heap, RSS, event loop delay, inflight requests and Redis
  command count every 100ms.
- `phases.ndjson`: duration and heap delta of each step that cost
  something (catalog fetch, `augmentEntries`, `prepareCacheValue`,
  `cloneDeep`, each retriever, `loadView`, Mustache), keyed by request, plus
  GC pauses over 100ms.
- `requests.ndjson`: status, bytes, duration and heap delta per request.
- `summary.json`: peaks, GC totals, Redis commands by type with reply sizes,
  LRU cache footprints, heap spaces.
- On a V8 out-of-memory crash, a Node report (`report.*.json`, without env
  vars) with the JS stack. With `--heap-snapshot`, a `.heapsnapshot` taken
  near the heap limit (open it in Chrome DevTools > Memory). This can be as
  large as the heap; the default 3g memory limit leaves room to write it.

The three `.ndjson` files are written as the probe runs, so they survive a crash.

Rendering only reads from Redis. The probe sets
`CONTAINER_NAME=blot-render-probe`, so its render-time metric doesn't mix
with the app containers'. A cold render of a large blog is heavy on the
shared Redis, so `--concurrency` is capped at 8; keep replays short.
