const clfdate = require("helper/clfdate");
const lock = require("helper/lock");
const bunnyStorage = require("helper/bunnyStorage");
const client = require("models/client");
const Blog = require("models/blog");
const permaCache = require("./permaCache");
const generated = require("./generated");

// The weekly sweep, one run and one walk. A run goes through the sorted union
// of Perma-Cache's top-level directories and the blogs in Redis (so a blog
// with nothing in Perma-Cache still has its generated files swept), and for
// each name:
//
// - a live blog: its generated files first (./generated: the transformer
//   cache in Redis, then the bucket), then the Perma-Cache check for its
//   directory, if it has one, using the blog's listing of the bucket after
//   the deletes, so that a file deleted from S3 in this pass is purged from
//   Bunny in the same pass. The order is Redis, S3, Bunny.
// - a blog in Perma-Cache with no blog in Redis: removed, with the guard
//   against more than 50 at once (./permaCache);
// - the shared directories (documentation, template outputs, static files,
//   anything else): ./permaCache.
//
// The run is resumable: it keeps the name below which everything has been
// swept (the cursor) in a Redis hash, and a deploy that kills it loses at
// most the entries in progress, which the next holder of the lease sweeps
// again. The names of the hash and the lease predate the move of the sweep
// into storage/sweep, when it was only Perma-Cache's: they stay, so that a
// run in progress at the time of the move resumes.
const STATE = "perma-cache:sweep";
const LEASE = "perma-cache:sweep:lease";
const INTERVAL = 7 * 24 * 60 * 60 * 1000;

// What the sweep of generated files does, per run:
// - "off": nothing;
// - "report": reads everything and fills the totals as if applying, but
//   writes nothing, so that "apply" starts at phase 1 (see ./generated);
// - "apply": deletes.
// A step's options can override it. The Perma-Cache part applies whatever
// the mode.
const GENERATED = "apply";

function newTotals() {
  return {
    ...permaCache.newTotals(),
    generatedBlogs: 0,
    candidates: 0,
    candidateBytes: 0,
    deletedDirs: 0,
    deletedBytes: 0,
    cacheKeysDeleted: 0,
    generatedFailed: 0,
  };
}

// The sorted union of Perma-Cache's top-level listing and the blogs in
// Redis. inPerma is whether the name is in Perma-Cache.
async function entriesOf(base) {
  const byName = new Map();

  for (const entry of await bunnyStorage.list(base))
    byName.set(entry.name, { ...entry, inPerma: true });

  const live = new Set(await Blog.getAllIDs());

  for (const id of live)
    if (!byName.has(id))
      byName.set(id, { name: id, isDirectory: true, inPerma: false });

  return { entries: permaCache.sortByName(Array.from(byName.values())), live };
}

// One name of the run
async function sweepOne(base, entry, context) {
  const { mode, live, totals } = context;
  let files = null;

  if (mode !== "off" && live.has(entry.name)) {
    try {
      files = await generated.run(entry.name, {
        mode,
        now: context.now,
        totals,
        log: context.log,
      });
    } catch (err) {
      // Nothing was deleted for the blog; the Perma-Cache check still runs,
      // with a listing of its own
      totals.failed++;
      totals.generatedFailed++;
      console.error(clfdate(), "sweep: generated files of", entry.name, err);
    }
  }

  if (entry.inPerma)
    await permaCache.sweepEntry(base, entry, {
      apply: true,
      log: () => {},
      totals,
      deleted: context.deleted,
      files,
    });

  // The candidate set of a blog that is gone would otherwise stay
  if (context.deleted.has(entry.name))
    await client.del(generated.candidatesKey(entry.name));
}

// One step of the sweep, run by start() below whenever it holds the lease:
// starts a run if the last finished INTERVAL ago, or resumes the one in
// progress from its cursor, saving the cursor as it goes. options: { now,
// generated (the mode), log }.
async function step(signal, options = {}) {
  const now = options.now || Date.now;
  const mode = options.generated || GENERATED;
  const state = await client.hGetAll(STATE);

  if (!state.startedAt) {
    if (state.finishedAt && now() - Number(state.finishedAt) < INTERVAL)
      return null;

    await client.hSet(STATE, { startedAt: String(now()), cursor: "" });
    await client.hDel(STATE, "totals");
    state.startedAt = String(now());
    state.cursor = "";
    delete state.totals;
  }

  const base = await permaCache.root();
  const all = await entriesOf(base);
  const entries = all.entries.filter(
    (entry) => entry.name > (state.cursor || "")
  );
  // Fresh defaults under the saved totals, which an older run saved without
  // the fields added since
  const totals = {
    ...newTotals(),
    ...(state.totals && JSON.parse(state.totals)),
  };
  const deleted = await permaCache.deletedBlogs(
    entries.filter((entry) => entry.inPerma)
  );

  try {
    permaCache.checkDeleted(deleted, { apply: true });
  } catch (err) {
    // Not retried until the next run: a person should look first
    await finish(state, totals, now, err.message);
    throw err;
  }

  const context = {
    mode,
    now: options.now,
    log: options.log,
    live: all.live,
    deleted,
    totals,
  };

  await permaCache.sweepEntries(
    base,
    entries,
    { totals },
    {
      signal,
      each: (entry) => sweepOne(base, entry, context),
      onDone: (name) =>
        client.hSet(STATE, { cursor: name, totals: JSON.stringify(totals) }),
    }
  );

  if (signal && signal.aborted) return null;

  await finish(state, totals, now);
  console.log(clfdate(), "Sweep:", mode, JSON.stringify(totals));
  return totals;
}

async function finish(state, totals, now, error) {
  await client
    .multi()
    .hSet(STATE, {
      finishedAt: String(now()),
      totals: JSON.stringify(totals),
      error: error || "",
    })
    .hDel(STATE, ["startedAt", "cursor"])
    .exec();
}

// Runs the sweep in the background on whichever process holds the lease,
// checking hourly whether a run is due. Returns the lease, to stop().
function start() {
  return lock.lease(
    LEASE,
    async (signal) => {
      try {
        await step(signal);
      } catch (err) {
        console.error(clfdate(), "Error: sweep", err);
      }
    },
    { ttl: 60 * 1000, heartbeat: 15 * 1000, retryEvery: 60 * 60 * 1000 }
  );
}

module.exports = { step, start, STATE, LEASE, GENERATED };
