const clfdate = require("helper/clfdate");
const lock = require("helper/lock");
const bunnyStorage = require("helper/bunnyStorage");
const client = require("models/client");
const Blog = require("models/blog");
const blogKey = require("models/blog/key");
const permaCache = require("./permaCache");
const generated = require("./generated");
const bucket = require("./s3");

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
// Most blogs don't change in a week, so most of that work finds nothing new.
// A main pass therefore skips a live blog's generated step and Perma-Cache
// check (skippedUnchanged in the totals) when nothing about it can have
// changed since a run last swept it:
//
// - its cacheID is older than the previous run's start, less a day (below);
// - it has no candidate set, which a run found to finish (./generated);
// - its step didn't fail last time (FAILED).
//
// Why the cacheID is enough. The sweep only ever has something new to do for
// a blog after a change to its folder, its entries, its templates or its
// settings that make a generated directory unreferenced or add one, or that
// change what Perma-Cache should hold. Every path that does that goes through
// a sync (a client's, or the dashboard's upload and delete, the demo blogs'),
// a rebuild (sync/rebuild), a scheduled publication or Fix(), each of which
// ends by setting the blog's cacheID, after the change; so does an edit of
// the template the blog has installed or of its menu, plugins, handle or
// domain (models/blog/set, models/template/util/cacheID). A blog whose
// cacheID is older than the previous run's start has had none of those since
// that run saw it, so a new run would find what that run left: nothing, or
// the candidates, which is why a blog with a candidate set is never skipped.
// The cacheID is compared with the previous start less a day (bucket.DAY),
// because a directory younger than a day is never a candidate (./generated):
// one made unreferenced just before the previous run started was too young
// for it to record, and is found by the next run, which a skip would miss.
//
// What the cacheID doesn't cover, and so is found a run later than it
// would be, or by the full run below: a template the blog hasn't installed,
// edited in the dashboard (nothing renders it for the blog, so its edit
// doesn't bump the blog); a settings save that changes nothing a render
// reads, such as a title or the date format; a sync whose files all built
// exactly the entries already stored, which creates no reference and so
// nothing new, but may leave a duplicate directory from a build that ran
// at the same time as another (./generated); and a bump that failed
// because Redis was unavailable for over a minute
// (models/blog/bumpCacheID). None of them can make the sweep delete
// something it shouldn't: skipping only delays what it would delete or purge.
//
// The backstop is a full run, with no skipping, every FULL_EVERY runs (about
// monthly), so such a miss is found within a month. The first run, and any
// run that follows one that didn't apply (a "report" or "off" run swept
// nothing in the way an "apply" run does), is full as well, and so is a run a
// step is told to make full. The run's choice is kept in the state (full)
// when it starts, so that a resumed run doesn't change its mind. A run that
// began before this was added has no such record, so it is full and records
// nothing for the next: it may have had failures nobody listed.
//
// A new run also starts only in a quiet hour, START_WINDOW (UTC): the sweep
// uses the units' CPU and memory, and what it does is nothing a person waits
// for. A run in progress carries on whatever the hour.
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
// The blogs whose generated step or Perma-Cache check failed in the last run
// that visited them: never skipped, until one succeeds
const FAILED = "perma-cache:sweep:failed";
// Every FULL_EVERY-th run sweeps every blog, skipping none
const FULL_EVERY = 4;
// A new run starts only from the hour FROM up to (not including) the hour TO,
// UTC
const START_WINDOW = { from: 2, to: 5 };

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
    skippedUnchanged: 0,
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

// Whether a live blog can be skipped (see the top): no change since the run
// before's start (less a day), no candidate set, no failure last time. A
// blog with no cacheID is never skipped.
async function unchanged(name, skipBefore) {
  const [cacheID, candidates, failed] = await client
    .multi()
    .hGet(blogKey.info(name), "cacheID")
    .exists(generated.candidatesKey(name))
    .sIsMember(FAILED, name)
    .exec();

  return (
    cacheID !== null &&
    cacheID !== undefined &&
    Number(cacheID) < skipBefore &&
    !candidates &&
    !failed
  );
}

// Records whether a live blog's step failed, for the next run (the FAILED
// set). Only an applying run clears a failure, since only it did the work.
async function settle(name, failed, mode) {
  if (failed) await client.sAdd(FAILED, name);
  else if (mode === "apply") await client.sRem(FAILED, name);
}

// One name of the run
async function sweepOne(base, entry, context) {
  const { mode, live, totals } = context;
  const isLive = live.has(entry.name);
  let files = null;
  let failed = false;

  if (isLive && context.skipBefore !== null) {
    if (await unchanged(entry.name, context.skipBefore)) {
      totals.skippedUnchanged++;
      return;
    }
  }

  if (mode !== "off" && isLive) {
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
      failed = true;
      totals.failed++;
      totals.generatedFailed++;
      console.error(clfdate(), "sweep: generated files of", entry.name, err);
    }
  }

  if (entry.inPerma) {
    // Counted apart from the run's, to tell whether this blog's check failed
    const own = permaCache.newTotals();

    try {
      await permaCache.sweepEntry(base, entry, {
        apply: true,
        log: () => {},
        totals: own,
        deleted: context.deleted,
        files,
      });
    } catch (err) {
      if (isLive) await settle(entry.name, true, mode);
      throw err;
    } finally {
      totals.stale += own.stale;
      totals.deletedBlogs += own.deletedBlogs;
      totals.failed += own.failed;
    }

    if (own.failed) failed = true;
  }

  if (isLive) await settle(entry.name, failed, mode);

  // The candidate set of a blog that is gone would otherwise stay
  if (context.deleted.has(entry.name))
    await client.del([
      generated.candidatesKey(entry.name),
      generated.markedKey(entry.name),
    ]);
}

// Whether a new run may start at this time (ms): the UTC hour is in the window
// ({ from, to }, to exclusive)
function inWindow(time, window = START_WINDOW) {
  const hour = new Date(time).getUTCHours();

  return hour >= window.from && hour < window.to;
}

// One step of the sweep, run by start() below whenever it holds the lease:
// starts a run if the last finished INTERVAL ago, or resumes the one in
// progress from its cursor, saving the cursor as it goes, and runs the second
// pass once it is due. A new run only starts in the START_WINDOW. options:
// { now, generated (the mode), log, secondPassDelay, window (replaces
// START_WINDOW), full (a run with no skipping) }.
async function step(signal, options = {}) {
  const now = options.now || Date.now;
  const mode = options.generated || GENERATED;
  const state = await client.hGetAll(STATE);

  if (!state.startedAt) {
    if (state.finishedAt && now() - Number(state.finishedAt) < INTERVAL)
      return null;

    if (!inWindow(now(), options.window)) return null;

    // Whether this run skips blogs, decided once for the whole run (see the
    // top). Runs are counted from the first.
    const runs = Number(state.runs || 0) + 1;
    const full =
      !!options.full || !state.previousStartedAt || runs % FULL_EVERY === 0;

    await client.hSet(STATE, {
      startedAt: String(now()),
      cursor: "",
      runs: String(runs),
      full: full ? "1" : "0",
    });
    await client.hDel(STATE, ["totals", "mainDoneAt", "secondCursor"]);
    state.startedAt = String(now());
    state.cursor = "";
    state.runs = String(runs);
    state.full = full ? "1" : "0";
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

  // The cacheID a blog has to be older than to be skipped, or null when
  // every blog is swept: a full run, one forced by the step's options, one in
  // a mode that doesn't apply (nothing swept then counts for the next run),
  // or a run that began before this was added (no "full" in its state)
  const skipBefore =
    mode !== "apply" ||
    options.full ||
    state.full !== "0" ||
    !state.previousStartedAt
      ? null
      : Number(state.previousStartedAt) - bucket.DAY;

  const context = {
    mode,
    now: options.now,
    log: options.log,
    live: all.live,
    deleted,
    totals,
    startedAt: Number(state.startedAt),
    skipBefore,
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
          await client.sAdd(FAILED, entry.name);
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
    await client.sAdd(FAILED, entry.name);
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
  const finished = {
    finishedAt: String(now()),
    totals: JSON.stringify(totals),
    error: error || "",
  };

  // The next run may skip what this one swept: only if it applied, finished
  // without an error and recorded its failures (it has "full" in its state)
  if (mode === "apply" && !error && state.full !== undefined)
    finished.previousStartedAt = state.startedAt;

  await client
    .multi()
    .hSet(STATE, finished)
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
  FAILED,
  FULL_EVERY,
  START_WINDOW,
  SECOND_PASS_DELAY,
};
