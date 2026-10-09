# build-probe

Rebuilds posts on production in a throwaway container while measuring memory,
to find which post (and which phase of rebuilding it) makes the heap spike -
e.g. green crashing with a V8 out-of-memory error during a sync - without
risking the live containers.

```
npm run build-probe -- https://www.example.com/some-post
npm run build-probe -- https://www.example.com/some-post --repeat 3 --heap-prof
npm run build-probe -- "example.com:/Posts/2026-10 Index.md" --snapshot-at 500
npm run build-probe -- https://www.example.com/some-post --mode sync --settle 10
npm run build-probe -- --help
```

A target is a post URL or `<blog>:<path>`, where `<blog>` is a blog ID, handle
or domain. A folder post given by URL is rebuilt from its `+` source folder.

## Modes

- `--mode build` (the default) only runs `build()` on each path. Nothing is
  saved to the entry, though a build still caches images and thumbnails.
- `--mode sync` is the real path, as `scripts/entry/rebuild.js` does it: take
  the blog's sync lock, `folder.update()` each path, then run the sync's own
  completion step (renames, templates). It writes to the database exactly as
  if the files had been re-saved, so it has the same customer-visible side
  effects:
  - the blog is purged from the proxy caches after each update;
  - its templates are rebuilt from its folder and renames are checked for;
  - its `cacheID` is bumped, which changes its CSS and JS URLs;
  - the dashboard shows "Syncing" while it runs;
  - it holds the blog's real sync lock, so a Dropbox (or other) sync for that
    blog arriving meanwhile fails to get it. Keep runs short.

  After each sync, `--settle` (default 5s) keeps measuring, to catch work the
  update starts but doesn't wait for, such as rebuilding wikilink dependents.
  Before exiting, the probe waits (up to 30s) for queued proxy purges to be
  sent; a purge a proxy rejects is recorded in Redis and retried by the app
  containers.

  Heap snapshots are refused in sync mode (`--snapshot-at`, `--heap-snapshot`,
  and no `USR2` snapshot): the sync lock is a Redis key with a 10s TTL kept
  alive by a 3s heartbeat, and writing a snapshot of a large heap blocks the
  event loop for longer than that, so a real sync could take the lock while
  the probe carries on writing.

## How it runs

`index.js` (run locally) checks the probe's arguments and hands the container
to the launcher shared by the production probes,
[`scripts/probe/run.js`](../probe/run.js) - see
[render-probe's README](../render-probe/README.md#how-it-runs) for what it
checks and how it cleans up. For build-probe the container:

- runs the same image and secrets as the app containers (yellow's current
  image, unless `--release`) and shares Redis with them;
- mounts the data directory **read-write**, since builds write to it, and the
  host's tmp directory (`/var/instance-ssd/tmp`) read-write, as the app
  containers do;
- is attached to the airlock network, since builds fetch remote images and
  take screenshots through it;
- has its own memory limit (default 2g: room for a heap snapshot on top of a
  full heap), heap limit (default 750MB, as green) and one CPU, so a spike
  here can't get a live container OOM-killed or starve it;
- runs node with `--expose-gc`, so each phase starts from a collected heap and
  reports what it retained. In build mode, also with
  `--heapsnapshot-signal=SIGUSR2`: for a snapshot mid-run, run
  `ssh blot docker kill -s USR2 <container>` from another terminal.

The exit status is the probe's: nonzero if any phase failed.

## What it records

Results are copied to `./data/build-probe/<run>/` and removed from the host:

- `phases.ndjson`: one `{ event: "start", label }` line per phase (acquire
  lock, each update or build, finish sync, settle) as it begins, so a crash
  mid-phase still shows which one was active, followed by one
  `{ event: "end", ... }` line as it ends: duration, heap before / peak /
  retained, RSS, external and ArrayBuffer peaks, worst event loop delay, GC
  count and time. Peaks come from a `v8.GCProfiler` as well as a 25ms
  sampler, so a spike inside one long synchronous step still shows. Written
  as it goes, so it survives the out-of-memory crash being investigated. A
  build phase's `htmlKB`/`entryJSONKB` are measured after its `end` line is
  written (so sizing the entry doesn't inflate its heap peak); they're
  logged to the console and land on that phase's entry in `summary.json`,
  not in this file.
- `summary.json`: options, targets, every phase and heap spaces, on a clean
  exit.
- `threshold-*.heapsnapshot`: from `--snapshot-at`, the first time the heap
  passes that size. It's checked between event loop turns, so it can't fire
  inside one long synchronous allocation; `--heap-snapshot` and `--heap-prof`
  cover that case.
- `Heap.*.heapsnapshot`: from `--heap-snapshot` (near the heap limit) or a
  `USR2` signal. Open them in Chrome DevTools > Memory.
- `*.heapprofile`: from `--heap-prof`, an allocation sampling profile
  (DevTools > Memory), written on a clean exit.
- On a V8 out-of-memory crash, a Node report (`report.*.json`, without env
  vars) with the JS stack.

These hold customer content, and the heap snapshots secrets from memory:
delete them when done.
