// Compaction for a blog served from the git store (#2259), after a write to
// the store (a push, Blot's commit) has swapped in a manifest. As in shadow
// mode: compact.plan decides locally, from the manifest the write already
// holds, whether there is anything worth doing, so a write in the steady
// state costs no request; and a blog's compactions run one at a time in this
// process, once more if one was asked for while one ran. In the background
// lane of the git limiter, under the blog's ref lock (./context.js).
//
//   compactAfter(blogID, manifest)   asks for one; returns at once
//   idle(blogID)                     resolves once none runs for the blog
//
// One line per compaction:
//
//   [git-store-served] blog=<id> op=compact outcome=... ms=... requests=...
const compact = require("../store/compact");
const limiter = require("../limiter");
const { measure } = require("../shadow/counting");
const context = require("./context");
const log = require("./log");

// blogID -> { running, again, waiters }
const blogs = new Map();

const stats = { compactions: 0, skipped: 0 };

function compactAfter(blogID, current) {
  try {
    const cache = context.cache();
    const options = compact.planOptions(cache);

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
      } while (state.again);

      blogs.delete(blogID);
      state.waiters.splice(0).forEach((resolve) => resolve());
    });
  } catch (err) {
    log({ blog: blogID, op: "compact", outcome: "error", detail: (err && (err.code || err.message)) || "error" });
  }
}

async function run(blogID, options) {
  try {
    const measured = await measure(() =>
      compact({ store: context.storeFor(blogID), cache: context.cache(), lock: context.refLock(blogID), ...options, gate: limiter.gate("background") })
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
      detail: result.error ? result.error.code || result.error.name || "error" : undefined,
    });
  } catch (err) {
    log({ blog: blogID, op: "compact", outcome: "error", detail: (err && (err.code || err.name)) || "error" });
  }
}

function idle(blogID) {
  const state = blogs.get(blogID);
  if (!state) return Promise.resolve();
  return new Promise((resolve) => state.waiters.push(resolve));
}

module.exports = { compactAfter, idle, stats };
