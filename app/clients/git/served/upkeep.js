// Compaction of a blog's repository in the git store (#2259), after a write
// to the store (a push, Blot's commit) has swapped in a manifest.
// compact.plan decides locally, from the manifest the write already holds,
// whether there is anything worth doing, so a write in the steady state costs
// no request; and a blog's compactions run one at a time in this process,
// once more if one was asked for while one ran. In the background lane of the
// git limiter, under the blog's ref lock (./context.js). None starts for a
// blog whose copy is being removed (./remove.js).
//
//   compactAfter(blogID, manifest)   asks for one; returns at once
//   idle(blogID)                     resolves once none runs for the blog
//
// One line per compaction:
//
//   [git-store-served] blog=<id> op=compact outcome=... ms=... requests=...
const compact = require("../store/compact");
const limiter = require("../limiter");
const { measure } = require("./counting");
const context = require("./context");
const log = require("./log");

// The most of .pack and .idx one compaction merges. The store's default is a
// quarter of the cache's budget, which with the host's one shared cache would
// be gigabytes of scratch and merging in the background; this keeps it where
// it was with each process's 1 GB cache.
const COMPACT_MAX_BYTES = 256 * 1024 * 1024;

// blogID -> { running, again, waiters }
const blogs = new Map();

const stats = { compactions: 0, skipped: 0 };

function compactAfter(blogID, current) {
  try {
    const cache = context.cache();
    const options = compact.planOptions(cache, {
      maxBytes: Math.min(
        COMPACT_MAX_BYTES,
        compact.planOptions(cache).maxBytes
      ),
    });

    if (require("./remove").isRemoved(blogID)) return;

    if (!current || !compact.plan(current, options)) {
      stats.skipped++;
      return;
    }

    let state = blogs.get(blogID);

    if (state) {
      state.again = true;
      return;
    }

    state = { running: null, again: false, waiters: [] };
    blogs.set(blogID, state);

    state.running = limiter.outside(async () => {
      do {
        state.again = false;
        stats.compactions++;
        await run(blogID, options);
      } while (state.again && !require("./remove").isRemoved(blogID));

      blogs.delete(blogID);
      state.waiters.splice(0).forEach((resolve) => resolve());
    });
  } catch (err) {
    log({
      blog: blogID,
      op: "compact",
      outcome: "error",
      detail: (err && (err.code || err.message)) || "error",
    });
  }
}

async function run(blogID, options) {
  try {
    const measured = await measure(() =>
      compact({
        store: context.storeFor(blogID),
        cache: context.cache(),
        lock: context.refLock(blogID),
        ...options,
        gate: limiter.gate("background"),
      })
    );
    const result = measured.result;
    const stats = result.stats || {};

    log({
      blog: blogID,
      op: "compact",
      outcome: result.outcome,
      ms: measured.ms,
      requests: measured.counts.requests,
      bytesUp: measured.counts.bytesUp,
      bytesDown: measured.counts.bytesDown,
      waitMs: measured.counts.waitMs,
      seq: result.seq,
      packsIn: stats.packsIn,
      bytesIn: stats.bytesIn,
      bytesOut: stats.bytesOut,
      detail: result.error
        ? result.error.code || result.error.name || "error"
        : undefined,
    });
  } catch (err) {
    log({
      blog: blogID,
      op: "compact",
      outcome: "error",
      detail: (err && (err.code || err.name)) || "error",
    });
  }
}

function idle(blogID) {
  const state = blogs.get(blogID);
  if (!state) return Promise.resolve();
  return new Promise((resolve) => state.waiters.push(resolve));
}

module.exports = { compactAfter, idle, stats };
