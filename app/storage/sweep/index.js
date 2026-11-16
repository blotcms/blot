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
// A run has a second pass, SECOND_PASS_DELAY after the main pass ends (the
// state's mainDoneAt), for the blogs the main pass left candidates for:
// ./generated deletes the candidates the main pass recorded, and the
// Perma-Cache check purges what that deleted, in the same visit. The
// lease's hourly step finds it due. Only then is the run finished and the
// next INTERVAL counted. A "report" or "off" run has no second pass: it
// records nothing to delete.
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
const SECOND_PASS_DELAY = 6 * 60 * 60 * 1000;

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
    legacyCacheKeys: 0,
    generatedFailed: 0,
    secondPassBlogs: 0,
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
        // Only candidates an earlier run recorded are deleted (./generated)
        markedBefore: context.startedAt,
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
    await client.del([
      generated.candidatesKey(entry.name),
      generated.markedKey(entry.name),
    ]);
}

// One step of the sweep, run by start() below whenever it holds the lease:
// starts a run if the last finished INTERVAL ago, or resumes the one in
// progress from its cursor, saving the cursor as it goes, and runs the second
// pass once it is due. options: { now, generated (the mode), log,
// secondPassDelay }.
async function step(signal, options = {}) {
  const now = options.now || Date.now;
  const mode = options.generated || GENERATED;
  const state = await client.hGetAll(STATE);

  if (!state.startedAt) {
    if (state.finishedAt && now() - Number(state.finishedAt) < INTERVAL)
      return null;

    await client.hSet(STATE, { startedAt: String(now()), cursor: "" });
    await client.hDel(STATE, ["totals", "mainDoneAt", "secondCursor"]);
    state.startedAt = String(now());
    state.cursor = "";
    delete state.totals;
    delete state.mainDoneAt;
    delete state.secondCursor;
  }

  if (state.mainDoneAt) return secondPass(signal, state, options);

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
    startedAt: Number(state.startedAt),
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

  // Nothing was recorded to delete unless applying
  if (mode !== "apply") return finish(state, totals, now, "", mode);

  await client.hSet(STATE, {
    mainDoneAt: String(now()),
    secondCursor: "",
    totals: JSON.stringify(totals),
  });
  console.log(clfdate(), "Sweep: main pass", JSON.stringify(totals));
  return null;
}

// The second pass: the blogs with a candidate set, visited again with only
// the candidates marked by the main pass or earlier eligible. Resumes from
// secondCursor, like the main pass.
async function secondPass(signal, state, options) {
  const now = options.now || Date.now;
  const mode = options.generated || GENERATED;
  const mainDoneAt = Number(state.mainDoneAt);
  const delay =
    options.secondPassDelay === undefined
      ? SECOND_PASS_DELAY
      : options.secondPassDelay;
  const totals = {
    ...newTotals(),
    ...(state.totals && JSON.parse(state.totals)),
  };

  if (mode !== "apply") return finish(state, totals, now, "", mode);

  if (now() < mainDoneAt + delay) return null;

  const base = await permaCache.root();
  const all = await entriesOf(base);
  const entries = all.entries.filter(
    (entry) =>
      all.live.has(entry.name) && entry.name > (state.secondCursor || "")
  );

  await permaCache.sweepEntries(
    base,
    entries,
    // sweepEntries counts these; the totals are the main pass's and ours
    { totals: { entries: 0, failed: 0 } },
    {
      signal,
      each: async (entry) => {
        try {
          await secondOne(base, entry, {
            mode,
            now: options.now,
            log: options.log,
            totals,
            markedBefore: mainDoneAt,
          });
        } catch (err) {
          totals.failed++;
          console.error(clfdate(), "sweep: second pass of", entry.name, err);
        }
      },
      onDone: (name) =>
        client.hSet(STATE, {
          secondCursor: name,
          totals: JSON.stringify(totals),
        }),
    }
  );

  if (signal && signal.aborted) return null;

  return finish(state, totals, now, "", mode);
}

// One live blog of the second pass, if it has candidates
async function secondOne(base, entry, context) {
  const { totals } = context;

  if (!(await client.exists(generated.candidatesKey(entry.name)))) return;

  let files = null;

  try {
    files = await generated.run(entry.name, {
      mode: context.mode,
      now: context.now,
      totals,
      log: context.log,
      markedBefore: context.markedBefore,
    });
  } catch (err) {
    totals.failed++;
    totals.generatedFailed++;
    console.error(clfdate(), "sweep: generated files of", entry.name, err);
  }

  totals.secondPassBlogs++;

  if (entry.inPerma)
    await permaCache.sweepEntry(base, entry, {
      apply: true,
      log: () => {},
      totals,
      deleted: new Set(),
      files,
    });
}

async function finish(state, totals, now, error, mode) {
  await client
    .multi()
    .hSet(STATE, {
      finishedAt: String(now()),
      totals: JSON.stringify(totals),
      error: error || "",
    })
    .hDel(STATE, ["startedAt", "cursor", "mainDoneAt", "secondCursor"])
    .exec();

  if (!error) console.log(clfdate(), "Sweep:", mode, JSON.stringify(totals));

  return totals;
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

module.exports = {
  step,
  start,
  STATE,
  LEASE,
  GENERATED,
  SECOND_PASS_DELAY,
};
