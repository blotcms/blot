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
const { warmRepo } = require("../store/warm");
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

    const totals = { blogs: 0, fetched: 0, cached: 0, bytes: 0, full: false, errors: 0 };
    const budget = Math.floor(cache.maxBytes / BUDGET_SHARE);
    const blogs = ids || (await require("./maintenance").gitBlogs());

    const measured = await counting.measure(async () => {
      let next = 0;
      const worker = async () => {
        while (next < blogs.length) {
          const blogID = blogs[next++];
          try {
            const result = await limiter.run("background", () =>
              warmRepo({ store: context.storeFor(blogID), cache, maxBytes: totals.full ? 0 : budget - totals.bytes })
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
    log({ op: "warm", outcome: "error", detail: (err && (err.code || err.message)) || "error" });
    return { outcome: "error", error: err };
  } finally {
    clearInterval(beat);
    await held.release();
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
    const stats = await Promise.all(["", "tmp", "scratch"].map((sub) => fs.stat(path.join(dir, sub)).catch(() => null)));
    if (!stats[0] || !stats[0].isDirectory()) continue;
    const newest = Math.max(...stats.filter(Boolean).map((stat) => stat.mtimeMs));
    if (now() - newest < LEGACY_IDLE) continue;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    removed.push(name);
  }

  if (removed.length) log({ op: "warm", outcome: "legacy-removed", detail: removed.length + " directories" });
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
  });
  later(DELAY + LEGACY_IDLE + MINUTE, () => removeLegacy());
}

function stop() {
  timers.forEach(clearTimeout);
  timers = [];
}

module.exports = { run, start, stop, removeLegacy, WARM_EVERY };
