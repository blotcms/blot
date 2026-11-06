// Warms the host's git store cache after a process starts (#2259), so the
// first push, clone or fetch of a blog after a deploy is not a cold one: for
// every blog on git, its newest manifest is read and the whole indexes and the
// history pack and pieces it names are put in the cache (../store/warm.js).
//
// One process on the host does it (a lock file in the cache's directory), and
// only if no process has finished a warm within WARM_EVERY, since the cache
// outlives deploys and every push and commit since has put its own packs
// there. What the cache already holds is not fetched. The blogs go through
// the background lane of the git limiter (../limiter.js), CONCURRENCY at a
// time, so it never holds up a push or a clone. It stops fetching once it has
// fetched a quarter of the cache's budget, or the cache stops taking what it
// fetches, so a host whose data has outgrown the cache only reads manifests.
//
// A second phase then streams the packs themselves into the cache (runPacks,
// below), newest repositories first, and stops well short of the budget.
//
// It also deletes the per-process cache directories which came before the
// shared one, once nothing has written to them for an hour.
//
// One line when it is done:
//
//   [git-store-served] op=warm outcome=warmed|skipped|error ms=... requests=...
//     bytesDown=... blogs=... fetched=... cached=... bytes=... full=...
//     errors=... reason=...
const fs = require("fs/promises");
const path = require("path");
const config = require("config");
const { warmRepo, packList, lastWritten, warmPack } = require("../store/warm");
const { cacheKeyOf, CACHE_SHARE } = require("../store/packcache");
const limiter = require("../limiter");
const counting = require("./counting");
const context = require("./context");
const log = require("./log");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// After the process starts, so it does not compete with startup
const DELAY = 2 * MINUTE;
const WARM_EVERY = 12 * HOUR;
const CONCURRENCY = 2;
const BUDGET_SHARE = 4;
const LOCK_STALE = 10 * MINUTE;

// A per-process cache directory unwritten for this long is not in use
const LEGACY_IDLE = HOUR;

async function run({ ids = null, force = false, now = Date.now } = {}) {
  const started = now();
  const cache = context.cache();
  const held = await cache.lock("warm", { staleMs: LOCK_STALE });

  if (!held) {
    log({ op: "warm", outcome: "skipped", reason: "locked" });
    return { outcome: "skipped", reason: "locked" };
  }

  const beat = setInterval(held.refresh, LOCK_STALE / 4);
  beat.unref();

  try {
    const last = await cache.readNote("warm");
    if (!force && last && started - last.finishedAt < WARM_EVERY) {
      log({ op: "warm", outcome: "skipped", reason: "warm" });
      return { outcome: "skipped", reason: "warm" };
    }

    const totals = {
      blogs: 0,
      fetched: 0,
      cached: 0,
      bytes: 0,
      full: false,
      errors: 0,
    };
    const budget = Math.floor(cache.maxBytes / BUDGET_SHARE);
    const blogs = ids || (await require("./maintenance").gitBlogs());

    const measured = await counting.measure(async () => {
      let next = 0;
      const worker = async () => {
        while (next < blogs.length) {
          const blogID = blogs[next++];
          try {
            const result = await limiter.run("background", () =>
              warmRepo({
                store: context.storeFor(blogID),
                cache,
                maxBytes: totals.full ? 0 : budget - totals.bytes,
              })
            );
            totals.blogs++;
            totals.fetched += result.fetched;
            totals.cached += result.cached;
            totals.bytes += result.bytes;
            if (result.full) totals.full = true;
          } catch (err) {
            totals.errors++;
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    });

    await cache.writeNote("warm", { finishedAt: now() });
    log({
      op: "warm",
      outcome: "warmed",
      ms: measured.ms,
      requests: measured.counts.requests,
      bytesDown: measured.counts.bytesDown,
      ...totals,
    });
    return { outcome: "warmed", ...totals, requests: measured.counts.requests };
  } catch (err) {
    log({
      op: "warm",
      outcome: "error",
      detail: (err && (err.code || err.message)) || "error",
    });
    return { outcome: "error", error: err };
  } finally {
    clearInterval(beat);
    await held.release();
  }
}

// The second phase: the packs themselves. Once the indexes and history are
// in, the packs of every blog on git are streamed into the cache, so a clone
// or fetch of any repository is served from local disk (a pack is read through
// the cache's copy, ../store/packcache.js).
//
//   Order    repositories by when their newest manifest was written, newest
//            first (one HEAD each, no Redis); within one, newest packs first.
//   Stops    once the cache holds PACK_SHARE of its budget (what was there
//            already included), or when the cache declines a pack (its budget
//            or the free-disk floor), so once the data outgrows the cache
//            only the hot set is warmed.
//   Gentle   one pack at a time, streamed (memory does not depend on the
//            pack's size) at no more than MAX_RATE, with a pause after each.
//            It takes no place in the git limiter (streaming from the bucket
//            is not a git process, and a long hold would delay Blot's own
//            commits); instead, before each pack and between chunks, it waits
//            (at most BUSY_MAX at a time) while either lane has work running
//            or waiting.
//   Once     under the same lock as the first phase, and not if a pack warm
//            finished in the last WARM_EVERY.
//
// One line when it is done:
//
//   [git-store-served] op=warm-packs outcome=warmed|skipped|error ms=...
//     requests=... bytesDown=... repos=... packs=... cached=... skipped=...
//     stopped=done|threshold|declined|... reason=...
const PHASE_GAP = MINUTE;
const PACK_SHARE = 0.7;
// A stream from the bucket to the disk is not a git process, so a pack takes
// no place in the limiter: it waits for both lanes to be idle instead. One
// pack at a time, at most this fast, so it never saturates the network at peak.
const MAX_RATE = 50 * 1024 * 1024;
const PAUSE = 250;
const BUSY_WAIT = 500;
const BUSY_MAX = 20 * 1000;

const sleep = (ms) =>
  ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();

// { blogID, store, manifest, time } for a blog, or null if it has no repository
async function loadRepo(blogID) {
  const store = context.storeFor(blogID);
  const manifest = await require("../store/manifest").read(store);
  if (!manifest || !manifest.packs) return null;
  return { blogID, store, manifest, time: await lastWritten(store, manifest) };
}

async function runPacks({
  ids = null,
  force = false,
  now = Date.now,
  load = loadRepo,
  limit = null,
  pause = PAUSE,
  busyWait = BUSY_WAIT,
} = {}) {
  const started = now();
  const cache = context.cache();
  const held = await cache.lock("warm", { staleMs: LOCK_STALE });

  if (!held) {
    log({ op: "warm-packs", outcome: "skipped", reason: "locked" });
    return { outcome: "skipped", reason: "locked" };
  }

  const beat = setInterval(held.refresh, LOCK_STALE / 4);
  beat.unref();

  try {
    const last = await cache.readNote("warm-packs");
    if (!force && last && started - last.finishedAt < WARM_EVERY) {
      log({ op: "warm-packs", outcome: "skipped", reason: "warm" });
      return { outcome: "skipped", reason: "warm" };
    }

    await cache.ready();
    const ceiling =
      limit === null ? Math.floor(cache.maxBytes * PACK_SHARE) : limit;
    const totals = {
      repos: 0,
      packs: 0,
      cached: 0,
      skipped: 0,
      failed: 0,
      stopped: "done",
    };
    const blogs = ids || (await require("./maintenance").gitBlogs());
    const order = [];

    const measured = await counting.measure(async () => {
      const repos = [];
      let next = 0;
      const loader = async () => {
        while (next < blogs.length) {
          const blogID = blogs[next++];
          try {
            const repo = await load(blogID);
            if (repo) repos.push(repo);
          } catch (err) {
            totals.failed++;
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, loader));
      repos.sort(
        (a, b) =>
          b.time - a.time || String(a.blogID).localeCompare(String(b.blogID))
      );

      const queue = [];
      for (const repo of repos)
        for (const pack of packList(repo.manifest)) queue.push({ repo, pack });

      const touched = new Set();
      let at = 0;
      const worker = async () => {
        while (at < queue.length && totals.stopped === "done") {
          const { repo, pack } = queue[at++];

          // A pack the cache would never keep is skipped, not a reason to stop
          if (pack.size > Math.floor(cache.maxBytes / CACHE_SHARE)) {
            totals.skipped++;
            continue;
          }

          if (
            cache.stats().entryBytes + pack.size > ceiling &&
            (await cache.size(cacheKeyOf(repo.store, pack.name))) !== pack.size
          ) {
            totals.stopped = "threshold";
            return;
          }

          await yieldToGit(busyWait);

          let outcome;
          try {
            outcome = await warmPack({
              store: repo.store,
              cache,
              pack,
              bytesPerSecond: MAX_RATE,
              between: () => yieldToGit(busyWait),
            });
          } catch (err) {
            outcome = "failed";
          }

          if (!touched.has(repo.blogID)) {
            touched.add(repo.blogID);
            order.push(repo.blogID);
          }
          if (outcome === "declined") totals.stopped = "declined";
          else if (outcome === "cached") totals.cached++;
          else if (outcome === "skipped") totals.skipped++;
          else if (outcome === "fetched") totals.packs++;
          else totals.failed++;

          await sleep(pause);
        }
      };
      await worker();
      totals.repos = touched.size;
    });

    await cache.writeNote("warm-packs", { finishedAt: now() });
    log({
      op: "warm-packs",
      outcome: "warmed",
      ms: measured.ms,
      requests: measured.counts.requests,
      bytesDown: measured.counts.bytesDown,
      ...totals,
    });
    return {
      outcome: "warmed",
      ...totals,
      order,
      requests: measured.counts.requests,
      bytesDown: measured.counts.bytesDown,
    };
  } catch (err) {
    log({
      op: "warm-packs",
      outcome: "error",
      detail: (err && (err.code || err.message)) || "error",
    });
    return { outcome: "error", error: err };
  } finally {
    clearInterval(beat);
    await held.release();
  }
}

// Either lane has work running or waiting: pushes, clones and fetches, or
// Blot's own commits
function busy() {
  const lanes = limiter.stats();
  return ["interactive", "background"].some(
    (name) => lanes[name].running + lanes[name].waiting > 0
  );
}

// Waits while the host is doing git work, for at most BUSY_MAX at a time, then
// carries on
async function yieldToGit(step = BUSY_WAIT) {
  let waited = 0;
  while (waited < BUSY_MAX && busy()) {
    await sleep(step);
    waited += step || BUSY_MAX;
  }
}

// Deletes the per-process caches which came before the shared one (<cache
// directory>/<container label>), each once nothing has been written to it,
// or to its tmp or scratch, for LEGACY_IDLE: a process still running the old
// code on the host keeps its own
async function removeLegacy({ now = Date.now } = {}) {
  const root = config.git_store.cache_directory;
  const shared = path.basename(context.cacheDirectory());
  const removed = [];

  for (const name of await fs.readdir(root).catch(() => [])) {
    if (name === shared) continue;
    const dir = path.join(root, name);
    const stats = await Promise.all(
      ["", "tmp", "scratch"].map((sub) =>
        fs.stat(path.join(dir, sub)).catch(() => null)
      )
    );
    if (!stats[0] || !stats[0].isDirectory()) continue;
    const newest = Math.max(
      ...stats.filter(Boolean).map((stat) => stat.mtimeMs)
    );
    if (now() - newest < LEGACY_IDLE) continue;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    removed.push(name);
  }

  if (removed.length)
    log({
      op: "warm",
      outcome: "legacy-removed",
      detail: removed.length + " directories",
    });
  return removed;
}

let timers = [];

// Called once the process is listening. Does nothing without a bucket.
function start() {
  if (timers.length || !context.hasStore()) return;

  const later = (ms, fn) => {
    const timer = setTimeout(() => fn().catch(() => {}), ms);
    timer.unref();
    timers.push(timer);
  };

  later(DELAY, async () => {
    await removeLegacy();
    await run();
    // The packs, after the indexes and history are in and a while apart
    await sleep(PHASE_GAP);
    await runPacks();
  });
  later(DELAY + LEGACY_IDLE + MINUTE, () => removeLegacy());
}

function stop() {
  timers.forEach(clearTimeout);
  timers = [];
}

module.exports = { run, runPacks, start, stop, removeLegacy, WARM_EVERY };
