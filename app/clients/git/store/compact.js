// Compaction: merges the repository's small packs into one, and its history
// pieces into the history pack, so the number of packs a clone or a lookup
// pays for stays small. It never runs on the push path; the host calls it in
// the background after a push.
//
//   const result = await compact({ store, cache, lock });
//
//   store         the repository's object store (see objectStore/memory.js)
//   cache         the cache (cache.js); the packs being merged are fetched
//                 into scratch space reserved from its budget, as a push's are
//   lock(fn)      the host's per-repository lock, passed to manifest.swap
//   keepRecent    the packs of this many of the newest pushes are left out of
//                 the merge (default 4), unless there are more than maxPacks
//   maxPacks      past this many packs that can still be merged (each under
//                 half of maxBytes), keepRecent is ignored (default 32)
//   factor        the geometric factor (default 2): see plan() below
//   minPieces     the history is rebuilt once there are this many history
//                 pieces (default 16)
//   maxBytes      the most bytes of .pack and .idx one merge takes in
//                 (default a quarter of the cache's budget)
//   clock         the clock manifest.read and swap time the base by (a
//                 merge held past manifest.MAX_BASE_AGE is built again on a
//                 fresh read, as a swap lost to a push is); for specs
//   pack          git pack-objects' settings, over PACK_CONFIG below; they
//                 are passed on the command line, so no system config applies
//   maxSnapshots, maxSnapshotBytes, minSnapshots
//                 how many ref snapshots the manifest keeps (manifest.js's
//                 SNAPSHOT_LIMITS: 1000, 1 MiB, at least 8). Every swap this
//                 makes trims to them; past them by `snapshotSlack` (10%) a
//                 swap is made for that alone, merging nothing
//
// The steps, in the order they run:
//
//   1. Read the newest manifest and plan (plan() below): which packs to merge,
//      whether to rebuild the history pack, and whether the snapshots are due
//      a trim. Nothing to do resolves at once; a trim alone goes to step 6.
//   2. Reserve scratch space from the cache for the inputs and the output, and
//      stream the inputs' .pack and .idx files into a throwaway bare repository
//      there.
//   3. `git pack-objects --stdin-packs --delta-base-offset` (not --thin) writes
//      one pack with every object of the inputs, reachable or not. Compaction
//      never drops an object; dropping is for the sweep.
//   4. Prove nothing was lost (the output's .idx holds every ID of every
//      input's .idx) and that the pack is self-contained (packscan.js finds no
//      delta base outside it), as every pack in a manifest must be.
//   5. Build the .rev, upload the .pack, .idx and .rev at once, and the
//      history pack and its .idx (read whole, so no .rev, like a piece).
//   6. Swap in manifest.compacted(...). A swap lost to a push or a commit is
//      built again on the newer manifest and retried, since those only add
//      packs and pieces. If one of the inputs is gone, another compaction got
//      there first, and this one is "superseded".
//
// Packs are named by their checksum, so a run which makes the same pack again
// (after a crash between the uploads and the swap, say) uploads the same bytes
// to the same keys, which is harmless. Nothing is deleted: the old packs stay
// in the store, so a clone or fetch that started on the old manifest reads on
// undisturbed. Removing packs no kept manifest names is sweep.js's job, run
// on a schedule of its own.
//
// compact() resolves with
//
//   outcome   "compacted"   the merged manifest is swapped in
//             "nothing"     there was nothing worth doing
//             "superseded"  another compaction removed some of the inputs first
//             "unknown"     the swap may or may not have happened, and reading
//                           back to find out failed (OutcomeUnknownError,
//                           returned as `error`). Nothing depends on it: the
//                           next run reads whichever manifest is there.
//   seq       the manifest swapped in (or read, when nothing was swapped)
//   merged    the names of the packs merged
//   into      the merged pack's name, or null
//   history   the new history pack's name, or null if it was not rebuilt
//   stats     { ms, attempts, packsIn, bytesIn, objectsIn, bytesOut, objectsOut,
//               piecesIn, historyBytesIn, historyBytesOut, commits,
//               historySkipped, snapshotsTrimmed }. historySkipped is null, or why the history
//               was due a rebuild but was left this run: "too large" (its
//               inputs are over maxBytes) or "no room" (the cache had no room
//               left for them once the packs had theirs)
//
// It throws for anything else (a NoRoomError when the cache has no room for
// the scratch space, an upload that failed, an Error with code EMOVED when the
// manifest moved under every attempt), and then the manifest is as it was.
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { pipeline } = require("stream/promises");
const { spawn } = require("child_process");
const { StaleManifestError, OutcomeUnknownError, CorruptError, NoRoomError } = require("./errors");
const { packKey, idxKey, revKey } = require("./layout");
const { mapLimit } = require("./limit");
const manifest = require("./manifest");
const { scanPack } = require("./packscan");
const { buildRev } = require("./rev");

const MiB = 1024 * 1024;

const DEFAULTS = { keepRecent: 4, maxPacks: 32, factor: 2, minPieces: 16, maxBytes: 256 * MiB, snapshotSlack: 1.1 };

// compact() takes no more than this share of the cache's budget for the inputs
// of a merge, unless maxBytes is given. Scratch holds them and the output.
const CACHE_SHARE = 4;

// Scratch for a merge is twice its inputs (the inputs and the output) and this
const SLACK = 64 * 1024;

// A swap lost to a push is retried this many times in all. Pushes and commits
// only add, so a retry needs no new upload, just a new manifest.
const ATTEMPTS = 5;

// How many inputs are fetched at once
const CONCURRENCY = 4;

// How long one git command may run
const GIT_TIMEOUT_MS = 60 * 60 * 1000;

const FANOUT_END = 8 + 256 * 4;

// What git pack-objects runs with. These are passed with -c, so the host's
// system git config (the Docker image's pack.window 5, say) does not change
// what compaction writes or how much memory it takes. See "Compaction" in the
// README for the measurements behind them. The memory ceiling is about
// windowMemory per thread for the delta window, plus deltaCacheSize, plus a
// few hundred bytes of bookkeeping for each object; a blob over
// bigFileThreshold is never held whole for a delta search, only streamed.
const PACK_CONFIG = {
  "pack.threads": "1",
  "pack.window": "10",
  "pack.depth": "50",
  "pack.windowMemory": "64m",
  "pack.deltaCacheSize": "32m",
  "core.bigFileThreshold": "32m",
  "pack.writeReverseIndex": "false",
  "pack.writeBitmaps": "false",
};

// ---- The plan ---------------------------------------------------------

// What to do with manifest `m`, without reading anything: resolves
//
//   { packs: [names to merge], history: true | false, trim: true | false }
//
// or null when there is nothing worth doing.
//
// Packs. Fetch sends whole every pack with a seq above the newest snapshot a
// client provably has, so merging the newest packs into one would make a
// client one push behind download all of them. The packs of the newest
// `keepRecent` pushes (by seq) are left alone for that, unless there are more
// than `maxPacks` packs that can still be merged (see Size below), which a
// burst of pushes or Blot commits can make: then
// the count matters more. Among the rest, sorted by size, the smallest split is
// found such that every pack above it is at least `factor` times the size of
// everything below it, and everything below it is merged (as `git repack
// --geometric`). The packs left then grow at least geometrically, so there are
// only as many as the log of the repository's size, and the big base pack is
// normally never rewritten. A merge of fewer than two packs is not one.
//
// Size. The inputs are fetched into scratch, which comes out of the cache, and
// a repository can be far larger than the cache. So the merge takes only the
// smallest packs of the split whose .pack and .idx together fit in `maxBytes`
// (and still at least two), past `maxPacks` too. A pack that never fits in a
// merge with another stays as it is: the count still comes down, and the big
// packs are left alone.
//
// History. Every push adds a history piece, which a fetch that has to walk
// history reads with a request of its own. Once there are `minPieces` of them
// they are merged into the history pack, which costs a read and a write of the
// whole history pack (commits only, a few hundred bytes each).
//
// Snapshots. Every push adds one, and every swap compaction makes trims them
// to the limits (manifest.trimSnapshots). So that they are trimmed even when
// no pack is worth merging, a trim alone is worth a swap once they are past
// the limits by `snapshotSlack` (10%): a manifest-only swap, about one in a
// hundred pushes at the count limit.
function plan(m, options = {}) {
  const { keepRecent, maxPacks, factor, minPieces, maxBytes, snapshotSlack } = { ...DEFAULTS, ...options };

  // Only packs that can still be merged count towards maxPacks. One whose
  // .pack and .idx are half of maxBytes or more stays as it is from then on
  // (two such never fit in one merge), so a repository much larger than
  // maxBytes always has many of them, and counting them would drop keepRecent
  // on every run and send a client one push behind a merged pack every time.
  const mergeable = m.packs.filter((pack) => pack.size + pack.idxSize < maxBytes / 2).length;

  let candidates = m.packs;
  if (mergeable <= maxPacks && keepRecent > 0) {
    const recent = new Set([...new Set(m.packs.map((pack) => pack.seq))].sort((a, b) => b - a).slice(0, keepRecent));
    candidates = m.packs.filter((pack) => !recent.has(pack.seq));
  }

  const sorted = [...candidates].sort((a, b) => a.size - b.size || (a.name < b.name ? -1 : 1));
  let split = 0;
  let below = 0;
  sorted.forEach((pack, i) => {
    if (pack.size < factor * below) split = i + 1;
    below += pack.size;
  });

  // The merge must fit in scratch: of the packs of the split, the smallest by
  // .pack and .idx together (what the cap counts; an .idx can be large next
  // to its pack) whose sum fits in maxBytes are taken
  const bytes = (pack) => pack.size + pack.idxSize;
  const byBytes = sorted.slice(0, split).sort((a, b) => bytes(a) - bytes(b) || (a.name < b.name ? -1 : 1));
  const taken = [];
  let total = 0;
  for (const pack of byBytes) {
    if (total + bytes(pack) > maxBytes) break;
    total += bytes(pack);
    taken.push(pack);
  }

  const packs = taken.length >= 2 ? taken.map((pack) => pack.name) : [];
  const history = (m.historyPieces || []).length >= Math.max(1, minPieces);
  const trim = snapshotsDue(m, options, snapshotSlack);
  return packs.length || history || trim ? { packs, history, trim } : null;
}

// The limits on snapshots in `options` (manifest.js's SNAPSHOT_LIMITS for
// those not given)
function snapshotLimits(options) {
  const limits = { ...manifest.SNAPSHOT_LIMITS };
  for (const name of Object.keys(limits)) if (options[name] !== undefined) limits[name] = options[name];
  return limits;
}

// Whether trimming to the limits, loosened by `slack`, would drop a snapshot
function snapshotsDue(m, options, slack) {
  const limits = snapshotLimits(options);
  const loose = {
    ...limits,
    maxSnapshots: Math.floor(limits.maxSnapshots * slack),
    maxSnapshotBytes: Math.floor(limits.maxSnapshotBytes * slack),
  };
  return manifest.trimSnapshots(m.snapshots, loose).length < m.snapshots.length;
}

// ---- Git in scratch ---------------------------------------------------

// The environment for git here: nothing from the host's own configuration
function gitEnvironment(gitDir) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith("GIT_")) env[name] = value;
  return { ...env, GIT_DIR: gitDir, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}

// Runs git; resolves with its stdout, or rejects with git's stderr
function runGit(children, args, { gitDir, input = "" }) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { env: gitEnvironment(gitDir), stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);

    children.add(child);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdin.on("error", () => {});
    child.on("error", (err) => {
      clearTimeout(timer);
      children.delete(child);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      children.delete(child);
      if (code === 0) return resolve(Buffer.concat(stdout).toString());
      reject(new Error("git " + args.join(" ") + " failed: " + Buffer.concat(stderr).toString().trim().slice(-1000)));
    });
    child.stdin.end(input);
  });
}

// ---- Inputs, outputs and proofs --------------------------------------

// The object IDs an .idx lists, as one Buffer of sorted 20-byte IDs
function idsOf(idx, name) {
  if (idx.length < FANOUT_END + 40 || idx.readUInt32BE(0) !== 0xff744f63 || idx.readUInt32BE(4) !== 2) {
    throw new CorruptError(name + " is not a version 2 pack index");
  }
  const count = idx.readUInt32BE(FANOUT_END - 4);
  if (idx.length < FANOUT_END + count * 28 + 40) throw new CorruptError(name + " is shorter than its fanout says");
  return { count, ids: idx.subarray(FANOUT_END, FANOUT_END + count * 20) };
}

// Throws unless every ID in `inner` (sorted) is in `outer` (sorted)
function assertContains(outer, inner, what) {
  let at = 0;
  for (let i = 0; i < inner.length; i += 20) {
    const id = inner.subarray(i, i + 20);
    while (at < outer.length && Buffer.compare(outer.subarray(at, at + 20), id) < 0) at += 20;
    if (at >= outer.length || !outer.subarray(at, at + 20).equals(id)) {
      throw new CorruptError("The merged pack lacks " + id.toString("hex") + " from " + what);
    }
  }
}

// Fetches a pack and its .idx into `dir`, streaming, and checks they are the
// sizes the manifest says and belong together. `downloads` is shared by every
// input of a run: the first copy to fail aborts the others, and each copy has
// settled (its streams closed, nothing more written) before this rejects, so
// scratch is never deleted under one still writing.
async function fetchInput(store, entry, dir, downloads) {
  const packFile = path.join(dir, entry.name + ".pack");
  const idxFile = path.join(dir, entry.name + ".idx");
  const copy = (key, file) =>
    pipeline(store.stream(key), fs.createWriteStream(file), { signal: downloads.controller.signal }).catch((err) => {
      if (!downloads.error) downloads.error = err;
      downloads.controller.abort();
      throw err;
    });
  const copies = await Promise.allSettled([copy(packKey(entry.name), packFile), copy(idxKey(entry.name), idxFile)]);
  if (copies.some((settled) => settled.status === "rejected")) throw downloads.error;

  const [packStat, idx] = await Promise.all([fsp.stat(packFile), fsp.readFile(idxFile)]);
  if (packStat.size !== entry.size || idx.length !== entry.idxSize) {
    throw new CorruptError(entry.name + " is not the size the manifest says");
  }
  const trailer = Buffer.alloc(20);
  const handle = await fsp.open(packFile, "r");
  try {
    await handle.read(trailer, 0, 20, entry.size - 20);
  } finally {
    await handle.close();
  }
  if (!idx.subarray(idx.length - 40, idx.length - 20).equals(trailer)) throw new CorruptError(entry.name + ".idx is not the index of its pack");
  return { entry, idx };
}

// Merges the packs `inputs` ({ entry, idx }, fetched into the repository at
// `gitDir`) into one pack in `outDir`, proves it, and describes it:
//
//   { name, size, idxSize, objects, packFile, idx, rev }
async function merge({ children, gitDir, outDir, inputs, packConfig, label }) {
  await fsp.mkdir(outDir, { recursive: true });
  const base = path.join(outDir, label);
  const config = Object.entries(packConfig).flatMap(([key, value]) => ["-c", key + "=" + value]);
  const args = [...config, "pack-objects", "--stdin-packs", "--delta-base-offset", "-q", base];
  const hash = (await runGit(children, args, { gitDir, input: inputs.map(({ entry }) => entry.name + ".pack").join("\n") + "\n" })).trim();

  const packFile = base + "-" + hash + ".pack";
  const idx = await fsp.readFile(base + "-" + hash + ".idx");
  const { size } = await fsp.stat(packFile);

  const head = Buffer.alloc(12);
  const trailer = Buffer.alloc(20);
  const handle = await fsp.open(packFile, "r");
  try {
    await handle.read(head, 0, 12, 0);
    await handle.read(trailer, 0, 20, size - 20);
  } finally {
    await handle.close();
  }

  // Nothing was lost: every object of every input is in the output
  const out = idsOf(idx, label);
  for (const { entry, idx: inputIdx } of inputs) assertContains(out.ids, idsOf(inputIdx, entry.name).ids, entry.name);
  if (head.readUInt32BE(8) !== out.count) throw new CorruptError("The merged pack's header does not count what its index lists");
  if (!idx.subarray(idx.length - 40, idx.length - 20).equals(trailer)) throw new CorruptError("The merged pack's index is not of the pack");

  // Self-contained: every delta base the pack names is in it
  const scanned = await scanPack(packFile);
  for (const oid of scanned.bases) {
    assertContains(out.ids, Buffer.from(oid, "hex"), "the pack's own delta bases (it is not self-contained)");
  }
  if (scanned.count !== out.count) throw new CorruptError("The merged pack holds a different number of entries than its index lists");

  return { name: "pack-" + trailer.toString("hex"), size, idxSize: idx.length, objects: out.count, packFile, idx, rev: buildRev(idx) };
}

// Uploads a pack, its index and (unless it is the history pack, which is read
// whole) its reverse index, all at once. Every upload has ended before this
// settles, so none is still reading from scratch when scratch is deleted.
async function upload(store, pack, { rev = true } = {}) {
  const stream = fs.createReadStream(pack.packFile);
  stream.on("error", () => {}); // the upload sees it too
  const puts = [store.put(packKey(pack.name), stream).finally(() => stream.destroy()), store.put(idxKey(pack.name), pack.idx)];
  if (rev) puts.push(store.put(revKey(pack.name), pack.rev));
  const failed = (await Promise.allSettled(puts)).find((put) => put.status === "rejected");
  if (failed) throw failed.reason;
}

const entryOf = ({ name, size, idxSize, objects }) => ({ name, size, idxSize, objects });

// ---- Compaction -------------------------------------------------------

async function compact({ store, cache, lock, pack = {}, attempts = ATTEMPTS, clock = Date.now, ...options }) {
  const packConfig = { ...PACK_CONFIG, ...pack };
  if (typeof lock !== "function") throw new Error("compact needs the host's lock function");

  const started = Date.now();
  const stats = {
    ms: 0,
    attempts: 0,
    packsIn: 0,
    bytesIn: 0,
    objectsIn: 0,
    bytesOut: 0,
    objectsOut: 0,
    piecesIn: 0,
    historyBytesIn: 0,
    historyBytesOut: 0,
    commits: 0,
    historySkipped: null,
    snapshotsTrimmed: 0,
  };
  const limits = snapshotLimits(options);
  const result = (outcome, extra) => ({ outcome, seq: null, merged: [], into: null, history: null, ...extra, stats: { ...stats, ms: Date.now() - started } });

  const base = await manifest.read(store, { clock });
  const maxBytes = options.maxBytes !== undefined ? options.maxBytes : cache.maxBytes > 0 ? Math.max(0, Math.floor((cache.maxBytes - SLACK) / CACHE_SHARE)) : DEFAULTS.maxBytes;
  const chosen = plan(base, { ...options, maxBytes });
  if (!chosen) return result("nothing", { seq: base.seq });

  const byName = new Map(base.packs.map((pack) => [pack.name, pack]));
  const packInputs = chosen.packs.map((name) => byName.get(name));
  let pieceInputs = chosen.history ? [...base.historyPieces] : [];
  let historyInputs = chosen.history ? [...(base.history ? [base.history] : []), ...pieceInputs] : [];
  const inputBytes = (inputs) => inputs.reduce((sum, pack) => sum + pack.size + pack.idxSize, 0);
  const skipHistory = (reason) => {
    stats.historySkipped = reason;
    pieceInputs = [];
    historyInputs = [];
  };

  // The history is rewritten whole, so it is budgeted on its own and never
  // holds up the packs: past maxBytes, or with no room left in the cache once
  // the packs have theirs, it is skipped this run
  if (historyInputs.length && inputBytes(historyInputs) > maxBytes) skipHistory("too large");

  // Swaps in the manifest with `merged` (the merged pack, or null) in place of
  // `packInputs`, and `history` (or null) in place of the old history pack and
  // `pieceInputs`, trimming the snapshots as it goes. A swap lost to a push or
  // a commit is built again on the newer manifest, since those only add.
  async function swapIn({ merged, history, packInputs, pieceInputs }) {
    const names = {
      merged: packInputs.map((pack) => pack.name),
      into: merged ? merged.name : null,
      history: history ? history.name : null,
    };
    const uploaded = [merged, history].filter(Boolean).map((pack) => pack.name);
    const through = Math.max(base.history ? base.history.through : 0, ...pieceInputs.map((piece) => piece.seq));

    // Whether `current` still lists everything this compaction merged: pushes
    // and commits only add packs and pieces, so a manifest that has moved on is
    // usually built on again. If an input is gone, someone compacted first.
    const stillListed = (current) => {
      const packs = new Set(current.packs.map((pack) => pack.name));
      const pieces = new Set((current.historyPieces || []).map((piece) => piece.name));
      const sameHistory = (current.history && current.history.name) === (base.history && base.history.name);
      return names.merged.every((name) => packs.has(name)) && (!history || (sameHistory && pieceInputs.every((piece) => pieces.has(piece.name))));
    };

    let current = base;
    for (let attempt = 1; ; attempt++) {
      stats.attempts = attempt;
      if (!stillListed(current)) return result("superseded", { seq: current.seq });

      const next = manifest.compacted(current, {
        remove: names.merged,
        add: merged ? entryOf(merged) : null,
        ...(history ? { history: { ...entryOf(history), through }, removePieces: pieceInputs.map((piece) => piece.name) } : {}),
        limits,
      });
      stats.snapshotsTrimmed = current.snapshots.length - next.snapshots.length;

      // A trim alone which another compaction has already made
      if (!merged && !history && !stats.snapshotsTrimmed) return result("nothing", { seq: current.seq });

      try {
        await manifest.swap({ store, lock, base: current, next, uploaded, clock });
        return result("compacted", { seq: next.seq, ...names });
      } catch (err) {
        if (err instanceof OutcomeUnknownError) return result("unknown", { seq: next.seq, ...names, error: err });
        if (!(err instanceof StaleManifestError)) throw err;
        if (attempt >= attempts) {
          throw Object.assign(new Error("The manifest moved " + attempts + " times while compacting"), { code: "EMOVED" });
        }
      }
      current = await manifest.read(store, { clock });
    }
  }

  // Only the snapshots to trim: a swap of the manifest, with nothing to fetch
  const trimOnly = () =>
    chosen.trim ? swapIn({ merged: null, history: null, packInputs: [], pieceInputs: [] }) : result("nothing", { seq: base.seq });

  if (!packInputs.length && !historyInputs.length) return trimOnly();

  // The inputs, and an output about as big as them, with room to spare
  const reservation = await cache.reserve(2 * inputBytes(packInputs) + SLACK);
  const children = new Set();

  try {
    if (historyInputs.length) {
      try {
        await reservation.extend(2 * inputBytes(historyInputs));
      } catch (err) {
        if (!(err instanceof NoRoomError)) throw err;
        skipHistory("no room");
      }
    }
    if (!packInputs.length && !historyInputs.length) return await trimOnly();

    stats.packsIn = packInputs.length;
    stats.bytesIn = packInputs.reduce((sum, pack) => sum + pack.size, 0);
    stats.objectsIn = packInputs.reduce((sum, pack) => sum + pack.objects, 0);
    stats.piecesIn = pieceInputs.length;
    stats.historyBytesIn = historyInputs.reduce((sum, pack) => sum + pack.size, 0);

    const gitDir = path.join(reservation.dir, "repo.git");
    const packDir = path.join(gitDir, "objects", "pack");
    await runGit(children, ["init", "-q", "--bare", gitDir], { gitDir });
    await fsp.mkdir(packDir, { recursive: true });

    // A pack can be both, after a push that brought only commits; it is
    // fetched once
    const unique = [...new Map([...packInputs, ...historyInputs].map((entry) => [entry.name, entry])).values()];
    // mapLimit waits for every fetch in flight before it rejects
    const downloads = { controller: new AbortController(), error: null };
    const fetched = new Map((await mapLimit(unique, CONCURRENCY, (entry) => fetchInput(store, entry, packDir, downloads))).map((input) => [input.entry.name, input]));

    const outDir = path.join(reservation.dir, "out");
    const merged = packInputs.length
      ? await merge({ children, gitDir, outDir, inputs: packInputs.map((entry) => fetched.get(entry.name)), packConfig, label: "merged" })
      : null;
    const history = historyInputs.length
      ? await merge({ children, gitDir, outDir, inputs: historyInputs.map((entry) => fetched.get(entry.name)), packConfig, label: "history" })
      : null;

    if (merged) {
      stats.bytesOut = merged.size;
      stats.objectsOut = merged.objects;
    }
    if (history) {
      stats.historyBytesOut = history.size;
      stats.commits = history.objects;
    }

    const uploads = await Promise.allSettled([...(merged ? [upload(store, merged)] : []), ...(history ? [upload(store, history, { rev: false })] : [])]);
    const failed = uploads.find((upload) => upload.status === "rejected");
    if (failed) throw failed.reason;

    return await swapIn({ merged, history, packInputs, pieceInputs });
  } finally {
    for (const child of children) child.kill("SIGKILL");
    await reservation.release().catch((err) => console.error("Git store: could not remove scratch space", err));
  }
}

module.exports = compact;
module.exports.plan = plan;
module.exports.DEFAULTS = DEFAULTS;
module.exports.snapshotLimits = snapshotLimits;
module.exports.PACK_CONFIG = PACK_CONFIG;
