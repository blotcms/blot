// Shadow mode for the git store (../store, see its README and #2259). The bare
// repositories on disk (data/git/<handle>.git, "EBS" below) stay the source of
// truth; every push and every one of Blot's commits is also mirrored into the
// store, under git/<blogID>/ in the storage bucket, so its correctness, timing
// and cost can be compared on real traffic before anything depends on it.
//
// repo.js calls two functions here, through ./hook.js, which loads this module
// only when shadow mode is on for the blog (config.git_store.shadow):
//
//   pushed(blogID, ebsMs)                     a push has moved some refs
//   committed(blogID, change, result, ebsMs)  Blot's commit has landed
//
// Both only queue work and return. Nothing here runs on the push path or the
// write path, waits for either, or throws into them: everything runs after,
// in the background, and its failures are logged.
//
// Each blog has one queue in this process, so its operations never overlap:
//
//   mirror   makes the store's refs equal to EBS's. An empty store is
//            imported (importRepo). Otherwise the ref updates are worked out
//            (old: the store's value, new: EBS's), and a thin pack of what the
//            store lacks, made by `git pack-objects` in the EBS repository, is
//            streamed into the store's receive with them. A push queues one,
//            and pushes while one is queued share it.
//   write    makes Blot's commit again in the store with its commit(), with the
//            same path, contents, identity and time, so the store makes the
//            same commit ID. That is the store's real write path. If the store
//            is not at the EBS commit's parent, or makes a different ID, a
//            mirror is queued instead, and the mismatch is logged.
//
// After an operation which changed the store, compaction runs in the
// background if compact.plan finds something to do in the manifest that
// operation swapped in, one at a time per blog, and once more if asked again
// while it ran. The sweep is not run here.
//
// Each operation logs one line (see log() below):
//
//   [git-store-shadow] blog=<id> op=push|write|import|compact outcome=...
//     storeMs=... [receiveMs=...|commitMs=...] ebsMs=... requests=...
//     bytesUp=... bytesDown=... refs=... waitMs=...
//
// storeMs is all the store's side took (for a push, reading its manifest and
// making the pack from the EBS repository too), less waitMs: the time its git
// commands spent waiting for a place in the git limiter's background lane
// (see below). receiveMs and commitMs leave those waits out too, and ebsMs
// never had them, so the figures compare the work alone however busy the
// lane was. The figures to compare are:
//
//   push    ebsMs (receivePack's start to the refs moving on EBS) with
//           receiveMs (the store's receive, from the pack's first byte to the
//           swap landing). Neither includes the client's upload.
//   write   ebsMs (the EBS ref lock and plumbing.commitFile) with commitMs
//           (the store's commit() alone)
//
// requests, bytesUp and bytesDown count all of storeMs's requests.
//
// with outcome=mismatch and a detail= for anything mirroring cannot explain.
// Blog handles and emails are kept out of the logs: IDs only.
//
// All of it is background work for the git limiter (../limiter.js), the
// mirror of a push too: every git process it starts, its own in the EBS
// repository (with the limiter's memory settings) and the store's (through
// the gate it is given), waits for a place in the background lane. inLane()
// puts each wait on the operation's lane clock (counting.js): waitMs on the
// line, and left out of the other figures.
const path = require("path");
const { PassThrough } = require("stream");
const { spawn } = require("child_process");
const { LRUCache } = require("lru-cache");
const config = require("config");
const clfdate = require("helper/clfdate");
const holdLock = require("helper/lock");
const { createCache, createS3Store, manifest } = require("../store");
const receive = require("../store/receive");
const storeCommit = require("../store/commit");
const compact = require("../store/compact");
const importRepo = require("../store/import");
const limiter = require("../limiter");
const counting = require("./counting");
const { measure } = counting;

const ZERO = "0".repeat(40);
const MASTER = "refs/heads/master";

// How many blogs' stores are kept for reuse. A store is a small object, but
// its memos (the manifest it last read, the sizes of its packs) only help if
// the same object is used for the next operation.
const STORES = 1000;

// Blot's writes wait in memory for their turn. Past this many, or this many
// bytes of contents, the queued writes are dropped and one mirror takes their
// place: a large upload is many writes, and the mirror catches up in one go.
const MAX_QUEUED_WRITES = 100;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;

// How long after a push or a write its mirror starts
const START_DELAY_MS = 250;

const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const STDERR_BYTES = 4096;

// ---- Logging ----------------------------------------------------------------

const ORDER = ["blog", "op", "source", "outcome", "storeMs", "receiveMs", "commitMs", "ebsMs", "firstByteMs", "requests", "bytesUp", "bytesDown", "bytesSent", "refs", "waitMs"];

function value(v) {
  const text = String(v);
  return /^[\w.:/@+-]*$/.test(text) && text ? text : JSON.stringify(text.slice(0, 500));
}

// One line per operation, the fields in a fixed order first
function log(fields) {
  const keys = ORDER.filter((key) => fields[key] !== undefined).concat(
    Object.keys(fields).filter((key) => ORDER.indexOf(key) === -1 && fields[key] !== undefined)
  );

  console.log(clfdate(), "[git-store-shadow] " + keys.map((key) => key + "=" + value(fields[key])).join(" "));

  // What a mirror came to, for mirror()'s caller (the backfill): a blog's
  // operations never overlap, so its last push or import line is the mirror's
  if (fields.op === "push" || fields.op === "import") outcomes.set(fields.blog, fields);
}

const outcomes = new Map();

// An error's message, with the blog's repository path and handle taken out
function scrub(err, ctx) {
  let message = String((err && (err.message || err)) || "unknown error");
  if (ctx) {
    message = message.split(ctx.gitDir).join("<repo>");
    if (ctx.handle) message = message.split(ctx.handle).join("<handle>");
  }
  return message.replace(/\s+/g, " ").trim();
}

function countsOf(measured) {
  return {
    storeMs: measured.ms,
    requests: measured.counts.requests,
    bytesUp: measured.counts.bytesUp,
    bytesDown: measured.counts.bytesDown,
    waitMs: measured.counts.waitMs,
  };
}

// ---- The store and its cache --------------------------------------------

// The object store for a blog: the storage bucket, under git/<blogID>/. The
// S3 client is asked for on each request, because storage/s3 replaces it if
// its configuration changes. Specs replace this with _setObjectStore.
function s3ObjectStore(blogID) {
  const s3 = require("storage/s3");

  s3.assertConfigured();

  return createS3Store({
    client: { send: (command) => s3.client().send(command) },
    bucket: config.storage.bucket,
    prefix: "git/" + blogID + "/",
  });
}

let makeObjectStore = s3ObjectStore;
let stores = new LRUCache({ max: STORES });
let cache = null;

// One cache per process, in a directory of its own, since a cache must own its
// directory (the units' two processes share tmp)
function sharedCache() {
  if (!cache) {
    const label = String(config.container || "").replace(/[^A-Za-z0-9_]+/g, "-").replace(/^-+|-+$/g, "") || "main";

    cache = createCache({
      dir: path.join(config.git_store.cache_directory, label),
      maxBytes: config.git_store.cache_bytes,
    });
  }

  return cache;
}

// The store's lock: held only around a manifest swap, as the store expects.
// Its own key, so it never waits on, or holds up, the EBS ref lock.
function storeLock(blogID) {
  const key = "blog:" + blogID + ":git:store-lock";

  return async function (fn) {
    const held = await holdLock(key, {
      ttl: 10 * 1000,
      heartbeat: 3 * 1000,
      retries: 6,
      minTimeout: 250,
      onCompromised: (err) => log({ blog: blogID, op: "lock", outcome: "compromised", detail: err.message }),
    });

    try {
      return await fn();
    } finally {
      await held.release().catch(() => {});
    }
  };
}

function storeFor(blogID) {
  let entry = stores.get(blogID);

  if (!entry) {
    entry = { store: counting(makeObjectStore(blogID)), lock: storeLock(blogID) };
    stores.set(blogID, entry);
  }

  return entry;
}

// The blog's store and the shared cache, for the test-only read route
// (./reads.js). The same store object the writes use, so it shares its memos.
function readContext(blogID) {
  return { store: storeFor(blogID).store, cache: sharedCache() };
}

// Everything an operation needs: the blog's EBS repository, its store, the
// cache and the lock. Null if the blog or its repository is gone.
async function contextFor(blogID) {
  if (removed.has(blogID)) return null;

  const blog = await new Promise((resolve, reject) => {
    require("models/blog").get({ id: blogID }, (err, blog) => (err ? reject(err) : resolve(blog)));
  });

  // A blog disconnected from git (or deleted) has its store copy removed
  // (removeBlog below): nothing may write to it again, in any process
  if (!blog || blog.client !== "git" || !blog.handle) return null;

  const handle = blog.handle;

  const gitDir = require("../repo").directory(handle);
  const exists = await require("fs-extra").pathExists(gitDir);

  if (!exists) return null;

  const { store, lock } = storeFor(blogID);

  return { blogID, handle, gitDir, store, lock, cache: sharedCache() };
}

// ---- Git in the EBS repository -----------------------------------------

// Runs a git command once it has a place in the background lane, with the
// time it waited for it on the operation's lane clock (counting.js), so
// waitMs records it and storeMs, receiveMs and commitMs leave it out
function inLane(start) {
  const granted = counting.waiting();

  return limiter
    .run("background", () => {
      granted();
      return start();
    })
    .finally(granted);
}

// The gate the store's git goes through (see store/README, "Limiting git")
const gate = inLane;

// Call only once the limiter has given the command a place
function spawnGit(gitDir, args) {
  return spawn("git", limiter.args(args), {
    cwd: gitDir,
    env: Object.assign({}, process.env, { GIT_DIR: gitDir, GIT_TERMINAL_PROMPT: "0" }),
    stdio: ["pipe", "pipe", "pipe"],
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
}

// Resolves with { code, stdout, stderr }, whatever the exit code
function git(gitDir, args, input) {
  return inLane(() => new Promise((resolve, reject) => {
    const child = spawnGit(gitDir, args);
    const stdout = [];
    let stderr = "";

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => {
      if (stderr.length < STDERR_BYTES) stderr += chunk;
    });
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code: signal ? 1 : code, stdout: Buffer.concat(stdout).toString(), stderr }));
    child.stdin.end(input);
  }));
}

async function gitOk(gitDir, args, input) {
  const result = await git(gitDir, args, input);
  if (result.code) throw new Error("git " + args[0] + " failed: " + result.stderr.trim());
  return result.stdout;
}

// The branches and tags, as { ref: oid }
async function ebsRefs(gitDir) {
  const output = await gitOk(gitDir, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"]);
  const refs = {};

  for (const line of output.split("\n")) {
    if (!line) continue;
    const space = line.indexOf(" ");
    refs[line.slice(space + 1)] = line.slice(0, space);
  }

  return refs;
}

// Which of the objects the EBS repository has
async function presentIn(gitDir, oids) {
  if (!oids.length) return [];
  const output = await gitOk(gitDir, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], oids.join("\n") + "\n");
  return output
    .split("\n")
    .filter((line) => line && !/ missing$/.test(line))
    .map((line) => line.split(" ")[0]);
}

async function isAncestor(gitDir, ancestor, descendant) {
  if (!ancestor || !descendant) return false;
  const result = await git(gitDir, ["merge-base", "--is-ancestor", ancestor, descendant]);
  return result.code === 0;
}

// A thin pack of everything reachable from the tips the store does not
// already reach, as a git push would send it. Returns the pack as a stream,
// which flows once git has a place in the background lane, and done(), which
// ends git and resolves with its exit and stderr.
//
// receive reads the whole pack into scratch before it starts any git of its
// own, so git here has closed, and given its place back, before the store's
// index-pack asks for one: a mirror never holds one place while it waits for
// another.
function packFor(gitDir, tips, have) {
  const stream = new PassThrough();
  let child = null;
  let stopped = false;

  const closed = inLane(() => {
    if (stopped) return { code: 1, stderr: "stopped before it started" };

    child = spawnGit(gitDir, ["pack-objects", "--revs", "--stdout", "--thin", "--delta-base-offset", "-q"]);

    let stderr = "";
    const exited = new Promise((resolve) => {
      child.on("close", (code, signal) => resolve({ code: signal ? 1 : code, stderr }));
      child.on("error", (err) => {
        stream.destroy(err);
        resolve({ code: 1, stderr: err.message });
      });
    });

    child.stderr.on("data", (chunk) => {
      if (stderr.length < STDERR_BYTES) stderr += chunk;
    });
    child.stdin.on("error", () => {});
    child.stdin.end(tips.concat(have.map((oid) => "^" + oid)).join("\n") + "\n");
    child.stdout.pipe(stream);

    return exited;
  });

  return {
    stream,
    // Waits for git, which has finished once its output has been read to the
    // end; if it was not (receive gave up on the pack), git is stopped, or
    // never started
    done() {
      if (!child) stopped = true;
      else if (!stream.readableEnded && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      return closed;
    },
  };
}

// The refs a push to the store can update: master and tags, as receivePack
// allows. Older repositories may have other branches, which only an import
// carries over.
function mirrorable(ref) {
  return ref === MASTER || ref.indexOf("refs/tags/") === 0;
}

// ---- Mirroring -------------------------------------------------------

async function runMirror(ctx, task) {
  const { blogID, gitDir, store, cache, lock } = ctx;
  const extra = { ebsMs: task.ebsMs, pushes: task.requests > 1 ? task.requests : undefined, reason: task.reason };

  for (let attempt = 1; ; attempt++) {
    const ebs = await ebsRefs(gitDir);
    let plan = null;

    const measured = await measure(async () => {
      const base = await manifest.read(store);
      if (base.seq === 0) return { imported: true, base };

      const refs = new Set(Object.keys(ebs).concat(Object.keys(base.refs)));
      const commands = [];
      const unmirrorable = [];

      for (const ref of refs) {
        const was = base.refs[ref] || ZERO;
        const now = ebs[ref] || ZERO;
        if (was === now) continue;
        if (mirrorable(ref)) commands.push({ old: was, new: now, ref });
        else unmirrorable.push(ref);
      }

      plan = { base, commands, unmirrorable };
      if (!commands.length) return null;

      const tips = [...new Set(commands.filter((c) => c.new !== ZERO).map((c) => c.new))];
      let pack = null;

      if (tips.length) {
        const have = await presentIn(gitDir, [...new Set(Object.values(base.refs))]);
        pack = packFor(gitDir, tips, have);
      }

      // receiveMs, the figure to compare with a push to EBS, is receive's
      // own time: from the pack's first byte (or the call, with no pack) to
      // the swap landing. What git took to start making the pack is left out;
      // a client's push to EBS is timed from when its request arrives. Time
      // spent waiting for a place in the git limiter is left out too.
      let firstByte = null;
      const source = pack
        ? (async function* () {
            for await (const chunk of pack.stream) {
              if (firstByte === null) firstByte = counting.stopwatch();
              yield chunk;
            }
          })()
        : null;

      try {
        const called = counting.stopwatch();
        const result = await receive({ store, cache, lock, commands, pack: source, gate });
        const receiveMs = (firstByte === null ? called : firstByte)();
        const git = pack ? await pack.done() : null;
        return { result, git, receiveMs };
      } catch (err) {
        if (pack) await pack.done();
        throw err;
      }
    });

    const outcome = measured.result;

    if (outcome && outcome.imported) {
      const imported = await runImport(ctx, ebs, extra, measured, task.scratchDir);

      // Another process imported it first: push onto what it imported
      if (imported === null && attempt < 2) continue;

      // An import is one pack: nothing to compact
      return null;
    }

    if (plan.unmirrorable.length) {
      log({
        blog: blogID,
        op: "push",
        outcome: "mismatch",
        detail: "refs the store cannot take by a push differ: " + plan.unmirrorable.join(", "),
      });
    }

    if (!outcome) {
      log({ blog: blogID, op: "push", outcome: "same", ...countsOf(measured), refs: 0, ...extra });
      return null;
    }

    const { result, git: packed, receiveMs } = outcome;
    const fields = {
      blog: blogID,
      op: "push",
      outcome: result.outcome,
      ...countsOf(measured),
      receiveMs,
      refs: plan.commands.length,
      ...extra,
      attempt: attempt > 1 ? attempt : undefined,
      seq: result.seq,
      objects: result.stats && result.stats.objects,
      packBytes: result.stats && result.stats.bytes,
      bases: result.stats && result.stats.basesFetched,
    };

    if (result.outcome === "ok") {
      log(fields);
      return { compact: result.manifest };
    }

    // A pack git could not make explains whatever receive said about it
    const why =
      packed && packed.code
        ? "git pack-objects failed: " + packed.stderr
        : [result.status !== "ok" ? result.status : null]
            .concat((result.results || []).filter((r) => r.error).map((r) => r.ref + ": " + r.error))
            .concat(result.error ? [result.error.message] : [])
            .filter(Boolean)
            .join("; ");

    // Refused: the store and EBS disagree on history, or another process
    // moved the store meanwhile. Once more from the store's refs as they are
    // now; if that is refused too, the store has something mirroring cannot
    // put right.
    if (result.outcome === "refused" && attempt < 2) {
      log({ ...fields, detail: scrub(why, ctx) + " (retrying from the store's refs)" });
      continue;
    }

    log({
      ...fields,
      outcome: result.outcome === "refused" ? "mismatch" : result.outcome,
      detail: scrub(why, ctx),
    });
    return null;
  }
}

// `before` is the measurement of the mirror's read which found the store
// empty, counted in with the import's. With scratchDir (the backfill's, on a
// large disk) the packs are built there, not in the cache's budget.
async function runImport(ctx, ebs, extra, before, scratchDir) {
  const { blogID, gitDir, store, cache, lock } = ctx;

  if (!Object.keys(ebs).length) {
    log({ blog: blogID, op: "import", outcome: "empty", refs: 0, ...extra });
    return false;
  }

  let measured;

  try {
    measured = await measure(() => importRepo({ store, cache, lock, gitDir, scratchDir: scratchDir || null, gate }));
  } catch (err) {
    // Another process imported it first: the next mirror pushes onto that
    if (err.code === "ENOTEMPTY" || err.code === "EMOVED") {
      log({ blog: blogID, op: "import", outcome: "raced", detail: err.code, ...extra });
      return null;
    }
    log({ blog: blogID, op: "import", outcome: "error", ...extra, detail: scrub(err, ctx) });
    return false;
  }

  const result = measured.result;

  if (before) {
    measured.ms += before.ms;
    for (const key of Object.keys(measured.counts)) measured.counts[key] += before.counts[key];
  }

  log({
    blog: blogID,
    op: "import",
    outcome: result.outcome,
    ...countsOf(measured),
    refs: result.refs ? Object.keys(result.refs).length : 0,
    ...extra,
    objects: result.pack && result.pack.objects,
    packBytes: result.pack && result.pack.size,
    skipped: result.skipped && result.skipped.length ? result.skipped.length : undefined,
    detail: result.error ? scrub(result.error, ctx) : undefined,
  });

  return result.outcome === "imported";
}

// ---- Blot's writes ------------------------------------------------------

// Who made an EBS commit, and when, from the commit itself
function authorOf(raw) {
  const match = /^author (.*) <([^>]*)> (\d+) ([+-]\d{4})$/m.exec(raw);
  if (!match) return null;
  return { name: match[1], email: match[2], seconds: Number(match[3]), zone: match[4] };
}

async function runWrite(ctx, task) {
  const { blogID, gitDir, store, cache, lock } = ctx;
  const ebs = task.result;
  const fields = { blog: blogID, op: "write", ebsMs: task.ebsMs };

  const raw = await gitOk(gitDir, ["cat-file", "commit", ebs.commit]);
  const author = authorOf(raw);

  // The store writes commits in UTC. One made in another zone cannot come
  // out the same, so it is not made: a mirror brings the store up to date.
  if (!author || author.zone !== "+0000") {
    log({ ...fields, outcome: "mismatch", detail: "the EBS commit is not in UTC (" + (author ? author.zone : "no author") + ")", ebsCommit: ebs.commit });
    return "mirror";
  }

  const change = task.change;
  const removing = change.contents === null || change.contents === undefined;

  // storeMs is the whole of the store's side: the read of its master and the
  // commit. commitMs, the figure to compare with the EBS commit (ebsMs), is
  // the store's commit() alone.
  const measured = await measure(async () => {
    // The store must be where EBS was, or the commit would be built on the
    // wrong parent
    const base = await manifest.read(store);
    const master = base.refs[MASTER] || null;

    if (base.seq === 0 || master !== (ebs.parent || null)) return { base, master };

    // commit() runs no git today; the stopwatch leaves out any lane wait anyway
    const elapsed = counting.stopwatch();
    const result = await storeCommit({
      store,
      cache,
      lock,
      path: change.path,
      contents: removing ? undefined : change.contents,
      remove: removing,
      identity: { name: author.name, email: author.email },
      now: author.seconds * 1000,
    });

    return { base, master, result, commitMs: elapsed() };
  });

  const { base, master, result, commitMs } = measured.result;

  if (base.seq === 0) {
    log({ ...fields, outcome: "skipped", ...countsOf(measured), detail: "the store is empty" });
    return "mirror";
  }

  if (!result) {
    // A mirror since the write landed already brought it over
    if (master === ebs.commit || (await isAncestor(gitDir, ebs.commit, master))) {
      log({ ...fields, outcome: "already", ...countsOf(measured), storeMaster: master, ebsCommit: ebs.commit });
      return null;
    }

    log({ ...fields, outcome: "mismatch", ...countsOf(measured), detail: "the store's master is not the EBS commit's parent", storeMaster: master, ebsParent: ebs.parent, ebsCommit: ebs.commit });
    return "mirror";
  }

  const out = { ...fields, outcome: result.outcome, ...countsOf(measured), commitMs, refs: 1, seq: result.seq };

  if (result.outcome === "unknown") {
    log({ ...out, detail: scrub(result.error, ctx) });
    return "mirror";
  }

  if (result.commit !== ebs.commit || (result.parent || null) !== (ebs.parent || null)) {
    log({ ...out, outcome: "mismatch", detail: "the store made a different commit", storeCommit: result.commit, storeParent: result.parent, ebsCommit: ebs.commit, ebsParent: ebs.parent });
    return "mirror";
  }

  log(out);
  return { compact: result.manifest };
}

// ---- Compaction --------------------------------------------------------

async function runCompact(ctx, options) {
  const { blogID, store, cache, lock } = ctx;
  const measured = await measure(() => compact({ store, cache, lock, ...options, gate }));
  const result = measured.result;
  const stats = result.stats || {};

  log({
    blog: blogID,
    op: "compact",
    outcome: result.outcome,
    ...countsOf(measured),
    seq: result.seq,
    packsIn: stats.packsIn,
    bytesIn: stats.bytesIn,
    bytesOut: stats.bytesOut,
    piecesIn: stats.piecesIn,
    historySkipped: stats.historySkipped || undefined,
    snapshotsTrimmed: stats.snapshotsTrimmed || undefined,
    detail: result.error ? scrub(result.error, ctx) : undefined,
  });
}

// ---- The queues -----------------------------------------------------------

// blogID -> { queue, draining, compacting, compactAgain, idle }
const blogs = new Map();

// For specs: how many operations have run, and whether two ever overlapped
const stats = { mirrors: 0, writes: 0, compactions: 0, compactionsSkipped: 0, overlaps: 0 };
const active = new Map();

function stateOf(blogID) {
  let state = blogs.get(blogID);

  if (!state) {
    state = { queue: [], draining: null, compacting: null, compactAgain: false, waiters: [] };
    blogs.set(blogID, state);
  }

  return state;
}

function settleIfIdle(blogID, state) {
  if (state.queue.length || state.draining || state.compacting) return;
  blogs.delete(blogID);
  state.waiters.splice(0).forEach((resolve) => resolve());
}

function start(blogID, state) {
  if (state.draining) return;

  // Not until the push has been answered, or the write has returned, so that
  // spawning git and the first requests never compete with their last steps.
  // Outside any place in the git limiter the caller holds (a push's apply
  // calls this under its interactive place), so shadow's git waits for room
  // in the background lane of its own.
  state.draining = limiter.outside(() => new Promise((resolve) => setTimeout(resolve, START_DELAY_MS)).then(() => drain(blogID, state)));
}

async function drain(blogID, state) {
  while (state.queue.length) {
    const task = state.queue.shift();
    let next = null;

    active.set(blogID, (active.get(blogID) || 0) + 1);
    if (active.get(blogID) > 1) stats.overlaps++;

    let ctx = null;

    outcomes.delete(blogID);

    try {
      ctx = await contextFor(blogID);

      if (!ctx) {
        log({ blog: blogID, op: task.type === "write" ? "write" : "push", outcome: "skipped", detail: "the blog is gone, off git or has no repository" });
      } else if (task.type === "write") {
        stats.writes++;
        next = await runWrite(ctx, task);
      } else {
        stats.mirrors++;
        next = await runMirror(ctx, task);
      }
    } catch (err) {
      log({ blog: blogID, op: task.type === "write" ? "write" : task.op, outcome: "error", detail: scrub(err, ctx) });
    } finally {
      active.set(blogID, active.get(blogID) - 1);
      if (!active.get(blogID)) active.delete(blogID);
    }

    if (next === "mirror") requestMirror(blogID, { op: "push", reason: "write" });
    if (next && next.compact && ctx) requestCompact(blogID, state, ctx, next.compact);

    task.resolve(task.type === "mirror" ? outcomes.get(blogID) : undefined);
    outcomes.delete(blogID);
  }

  state.draining = null;
  settleIfIdle(blogID, state);
}

// Queues a mirror, unless the last thing queued is one already, which then
// covers this request too: it reads both sides when it starts.
function requestMirror(blogID, { op = "push", ebsMs, reason, scratchDir } = {}) {
  if (removed.has(blogID)) return Promise.resolve();

  const state = stateOf(blogID);
  const last = state.queue[state.queue.length - 1];

  if (last && last.type === "mirror") {
    last.requests++;
    if (ebsMs !== undefined) last.ebsMs = ebsMs;
    if (last.reason !== reason) last.reason = undefined;
    if (scratchDir) last.scratchDir = scratchDir;
    return last.done;
  }

  const task = { type: "mirror", op, ebsMs, reason, scratchDir, requests: 1 };
  task.done = new Promise((resolve) => (task.resolve = resolve));
  state.queue.push(task);
  start(blogID, state);

  return task.done;
}

// Compacts in the background, if the manifest the operation just swapped in
// (and so already holds) has anything worth doing: compact.plan decides that
// locally, with the options compact() itself would use, so a push or a write
// in the steady state costs no compaction request at all.
function requestCompact(blogID, state, ctx, current) {
  if (removed.has(blogID)) return;

  const options = compact.planOptions(ctx.cache);

  if (!current || !compact.plan(current, options)) {
    stats.compactionsSkipped++;
    return;
  }

  if (state.compacting) {
    state.compactAgain = true;
    return;
  }

  state.compacting = (async () => {
    do {
      state.compactAgain = false;
      stats.compactions++;
      try {
        await runCompact(ctx, options);
      } catch (err) {
        log({ blog: blogID, op: "compact", outcome: "error", detail: scrub(err, ctx) });
      }
    } while (state.compactAgain && !removed.has(blogID));

    state.compacting = null;
    settleIfIdle(blogID, state);
  })();
}

// A push has moved the EBS repository's refs. ebsMs is how long the push took
// from its start to the refs moving.
function pushed(blogID, ebsMs) {
  try {
    requestMirror(blogID, { op: "push", ebsMs });
  } catch (err) {
    log({ blog: blogID, op: "push", outcome: "error", detail: scrub(err) });
  }
}

// Blot's commit has landed on EBS: result is { parent, commit } from
// plumbing.commitFile, and ebsMs how long it took
function committed(blogID, change, result, ebsMs) {
  if (removed.has(blogID)) return;

  try {
    const state = stateOf(blogID);
    const queued = state.queue.filter((task) => task.type === "write");
    const bytes = queued.reduce((sum, task) => sum + task.bytes, 0);
    const size = change.contents === null || change.contents === undefined ? 0 : Buffer.byteLength(change.contents);

    // Too much waiting: a mirror catches up instead
    if (queued.length >= MAX_QUEUED_WRITES || bytes + size > MAX_QUEUED_BYTES) {
      state.queue = state.queue.filter((task) => {
        if (task.type === "write") task.resolve();
        return task.type !== "write";
      });
      log({ blog: blogID, op: "write", outcome: "skipped", detail: "backlog", dropped: queued.length + 1 });
      requestMirror(blogID, { op: "push", reason: "backlog" });
      return;
    }

    const task = { type: "write", change: { path: change.path, contents: change.contents }, result: { parent: result.parent, commit: result.commit }, ebsMs, bytes: size };
    task.done = new Promise((resolve) => (task.resolve = resolve));
    state.queue.push(task);
    start(blogID, state);
  } catch (err) {
    log({ blog: blogID, op: "write", outcome: "error", detail: scrub(err) });
  }
}

// ---- Removing a blog's store copy -----------------------------------------

// Blogs whose store copy is being or has been removed in this process, with
// when: their hooks are ignored until the second pass below
const removed = new Map();

// How long after removing a store copy it is removed again, for work another
// process (the other unit) had already started when the blog was
// disconnected. Work which starts later finds the blog off git and does
// nothing (contextFor).
let removeAgainMs = 5 * 60 * 1000;

// The second passes waiting to run, so _reset() can cancel them: a spec's
// disconnect would otherwise reach into a spec running minutes later
const removeAgainTimers = new Set();

// Deletes every object under the blog's prefix, a few at a time
async function deleteCopy(blogID) {
  if (makeObjectStore === s3ObjectStore && !(config.storage && config.storage.bucket)) return null;

  const store = makeObjectStore(blogID);
  const keys = [];

  for await (const entry of store.list("")) keys.push(entry.key);

  let next = 0;
  const worker = async () => {
    while (next < keys.length) await store.delete(keys[next++]);
  };

  await Promise.all(Array.from({ length: Math.min(16, keys.length) }, worker));

  return keys.length;
}

async function deleteAndLog(blogID, pass) {
  try {
    const deleted = await deleteCopy(blogID);
    if (deleted) log({ blog: blogID, op: "remove", outcome: "ok", deleted, pass });
  } catch (err) {
    log({ blog: blogID, op: "remove", outcome: "error", pass, detail: scrub(err) });
  }
}

// The blog's git client is disconnected, or the blog deleted: stops this
// process's shadow work for it (queued work is dropped, running work is
// waited for, later hooks are ignored), forgets its store, and deletes its
// copy in the store, git/<blogID>/. Runs whether or not shadow mode is on
// now, since it may have been before. Deletes the copy again a while later,
// unless the blog is back on git by then. Never rejects: a failure is logged.
async function removeBlog(blogID) {
  removed.set(blogID, Date.now());

  try {
    const state = blogs.get(blogID);

    if (state) {
      state.queue.splice(0).forEach((task) => task.resolve());
      state.compactAgain = false;
      await Promise.all([state.draining, state.compacting].map((running) => running && running.catch(() => {})));
    }

    stores.delete(blogID);
  } catch (err) {
    log({ blog: blogID, op: "remove", outcome: "error", detail: scrub(err) });
  }

  await deleteAndLog(blogID, 1);

  const again = setTimeout(() => {
    removeAgainTimers.delete(again);
    require("models/blog").get({ id: blogID }, async (err, blog) => {
      // Back on git: its new copy is not ours to delete
      if (err || !blog || blog.client !== "git") await deleteAndLog(blogID, 2);
      removed.delete(blogID);
    });
  }, removeAgainMs);

  removeAgainTimers.add(again);
  if (again.unref) again.unref();
}

// Makes the store's refs equal to EBS's, in the queue. Resolves once done,
// with the fields of the mirror's last log line (op=push or op=import, with
// its outcome), or undefined if it was dropped; never rejects. options:
// reason, for the log line, and scratchDir, where an import builds its packs.
function mirror(blogID, { reason = "asked", scratchDir } = {}) {
  return requestMirror(blogID, { op: "push", reason, scratchDir });
}

// Whether there is a bucket to shadow into (or a spec's stores)
function hasStore() {
  return makeObjectStore !== s3ObjectStore || !!(config.storage && config.storage.bucket);
}

// A blog's object store, uncounted and not kept, for the daily maintenance
// (./maintenance.js), which lists and deletes what is left of blogs off git
function objectStoreFor(blogID) {
  return makeObjectStore(blogID);
}

// Resolves once nothing is queued or running for the blog, compaction included
function idle(blogID) {
  const state = blogs.get(blogID);
  if (!state) return Promise.resolve();
  return new Promise((resolve) => state.waiters.push(resolve));
}

// For specs: the object store a blog's store is made on (null for S3), and
// forgetting the stores and the cache made so far
function _setObjectStore(factory) {
  makeObjectStore = factory || s3ObjectStore;
  _reset();
}

function _setRemoveAgainMs(ms) {
  removeAgainMs = ms;
}

function _reset() {
  stores = new LRUCache({ max: STORES });
  cache = null;
  removed.clear();
  outcomes.clear();
  removeAgainTimers.forEach((timer) => clearTimeout(timer));
  removeAgainTimers.clear();
  Object.keys(stats).forEach((key) => (stats[key] = 0));
}

module.exports = {
  pushed,
  committed,
  mirror,
  idle,
  removeBlog,
  contextFor,
  ebsRefs,
  git,
  gate,
  log,
  scrub,
  hasStore,
  objectStoreFor,
  readContext,
  stats,
  _setObjectStore,
  _setRemoveAgainMs,
  _reset,
  _log: log,
};
