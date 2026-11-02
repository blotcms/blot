// Rewrites one repository so that it holds only the objects its refs reach,
// and, when asked, deletes the rest from the store now. The store otherwise
// never loses an object: compaction keeps unreachable ones, and the sweep only
// deletes packs no kept manifest names. So when a user scrubs something from
// their history (a leaked secret, a file they must remove) and force pushes,
// the old objects stay until this is run. It is an operator's tool
// (scripts/git/rewrite-repo.js), never run on the push path.
//
//   const result = await rewriteRepo({ store, cache, lock });
//
//   store       the repository's object store (see objectStore/memory.js)
//   cache       the cache (cache.js), whose budget the scratch space is
//               reserved from, as for an import. Not needed with scratchDir.
//   lock(fn)    the host's per-repository lock, passed to manifest.swap
//   scratchDir  a directory to work in instead of a reservation from the
//               cache, for a repository bigger than the cache. A directory of
//               its own is made inside it and removed in every case.
//   purge       delete every pack the new manifest does not name, now (see
//               purge() below). Without it, the old packs go through the
//               sweep once the old manifests leave its recovery window. The
//               old manifests stay either way: they hold no content.
//   dryRun      do everything up to the uploads, in scratch, and report what
//               would be dropped (and, with purge, deleted). Writes nothing to
//               the store.
//   pack        git pack-objects' settings, over PACK_CONFIG (compact.js)
//   clock       the clock manifest.read and swap time the base by; for specs
//
// The steps:
//
//   1. Read the newest manifest. An empty repository (seq 0) has nothing to
//      rewrite.
//   2. Stream its packs into a bare repository in scratch, as compaction does,
//      and with `git pack-objects --revs` (the settings and clean environment
//      of import.js) write one pack of everything the refs reach and one of
//      the commits among it. Prove them as an import does: header, index and
//      checksum agree, every delta base is inside, every ref tip and peeled
//      target is in the pack, every commit is in both, and the pack is closed
//      (`rev-list --objects --missing=error` in a repository holding only it).
//   3. Upload both, and swap in manifest.rewritten(...): the same refs, head
//      and peeled targets; the one pack and the history pack, with the new
//      seq; no history pieces; one snapshot, of the refs as they are; and a
//      new `epoch`, which every cache of objects by ID is keyed by (see
//      reader.js), so nothing cached before the rewrite stands in for the
//      packs after it.
//   4. A swap lost to another writer is tried again. If the refs, head and
//      epoch of the newer manifest are the base's (a compaction landed), the
//      packs already uploaded still hold everything the refs reach, and only
//      the manifest is built again. Otherwise (a push or a commit moved a
//      ref, or another rewrite landed) everything is done again from step 2,
//      so the new objects are in the pack. ATTEMPTS in all, then EMOVED.
//   5. With `purge`, purge() (below).
//
// It resolves with
//
//   outcome   "rewritten", "empty" (seq 0, nothing done), "dry-run",
//             "unknown" (the swap may or may not have happened and reading
//             back failed: OutcomeUnknownError, as `error`; run it again), or
//             "damaged": rewritten, but after the purge a pack the newest
//             manifest names is missing (`purged.missing`; see purge())
//   seq       the manifest swapped in (for a dry run, the one read)
//   epoch     its epoch
//   before    { packs, bytes, objects } of the manifest rewritten: the packs,
//             history pack and pieces it names, their .pack and .idx bytes,
//             and the distinct objects in its packs
//   after     the same for the new manifest
//   dropped   { objects, bytes }: before less after
//   purged    { packs, bytes, spared, missing } (zero without purge); for a
//             dry run with purge, `wouldPurge` ({ packs, bytes }) says what
//             would go
//   stats     { ms, attempts, gitMs, uploadMs, swapMs, purgeMs, requests }
//
// It throws for anything else (a NoRoomError, a git failure, a CorruptError
// when a proof fails, EMOVED), and then the manifest is as it was, unless the
// failure was in the purge, which runs after the swap and is safe to repeat
// by running purge() again.
const fsp = require("fs/promises");
const path = require("path");
const { StaleManifestError, OutcomeUnknownError, CorruptError, NoRoomError } = require("./errors");
const { SWEEP_KEY, PACK_PREFIX, manifestKey, packKey, idxKey, packFile } = require("./layout");
const { mapLimit } = require("./limit");
const manifest = require("./manifest");
const { PACK_CONFIG, git: shared } = require("./compact");
const { internals } = require("./import");

const { runGit, fetchInput, CONCURRENCY } = shared;
const { counting, peelTags, describePack, packEverything, packCommits, proveClosed, watchGrowth, upload, has, entryOf, SLACK } = internals;

// A swap lost to another writer is tried again this many times in all
const ATTEMPTS = 3;

const EXTS = ["pack", "idx", "rev"];

function coded(message, code, extra) {
  return Object.assign(new Error(message), { code }, extra);
}

const sameRefs = (a, b) => {
  const names = Object.keys(a);
  return names.length === Object.keys(b).length && names.every((name) => a[name] === b[name]);
};

// Whether packs made from `a` are still right for `b`: the same refs and head
// (so the same objects reached) and the same epoch (so no rewrite, and no
// purge which could have deleted them, came between)
const sameState = (a, b) => sameRefs(a.refs, b.refs) && a.head === b.head && manifest.epochOf(a) === manifest.epochOf(b);

// The packs, history pack and pieces a manifest names, as manifest entries
function namedEntries(m) {
  return [...m.packs, ...(m.history ? [m.history] : []), ...(m.historyPieces || [])];
}

const bytesOf = (entries) => entries.reduce((sum, entry) => sum + entry.size + entry.idxSize, 0);

// ---- Making the packs -----------------------------------------------------

// Fetches `base`'s packs into scratch, writes and proves the pack of what its
// refs reach and the history pack, and (unless `dryRun`) uploads them.
// Resolves with { from, main, history, peeled, before, after, uploaded }.
async function make({ store, cache, scratchDir, base, packConfig, dryRun, stats }) {
  const children = new Set();
  let reservation = null;
  let dir = null;

  try {
    if (scratchDir) {
      await fsp.mkdir(scratchDir, { recursive: true });
      dir = await fsp.mkdtemp(path.join(scratchDir, "rewrite-"));
    } else {
      try {
        // The inputs, and an output no bigger than them, with room to spare;
        // extended as git writes if that is not enough
        reservation = await cache.reserve(2 * bytesOf(base.packs) + SLACK);
      } catch (err) {
        if (err instanceof NoRoomError) err.message += " (a repository bigger than the cache can be rewritten with scratchDir, a directory on a larger disk)";
        throw err;
      }
      dir = reservation.dir;
    }

    let mark = Date.now();
    const repo = path.join(dir, "repo.git");
    const packDir = path.join(repo, "objects", "pack");
    await runGit(children, ["init", "-q", "--bare", repo], { gitDir: repo });
    await fsp.mkdir(packDir, { recursive: true });

    // mapLimit waits for every fetch in flight before it rejects
    const downloads = { controller: new AbortController(), error: null };
    await mapLimit(base.packs, CONCURRENCY, (entry) => fetchInput(store, entry, packDir, downloads));

    const all = (await runGit(children, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"], { gitDir: repo })).split("\n").filter(Boolean);
    const before = { packs: namedEntries(base).length, bytes: bytesOf(namedEntries(base)), objects: all.length };

    const refs = base.refs;
    const tips = [...new Set(Object.values(refs))];
    if (!tips.length) {
      stats.gitMs += Date.now() - mark;
      return { from: base, main: null, history: null, peeled: {}, before, after: { packs: 0, bytes: 0, objects: 0 }, uploaded: [] };
    }

    // What each ref points at, for the peeled targets and the history's tips
    const kinds = {};
    const typeOf = new Map();
    const listing = await runGit(children, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { gitDir: repo, input: tips.join("\n") + "\n" });
    listing.split("\n").forEach((line, i) => {
      if (i < tips.length) typeOf.set(tips[i], line.split(" ")[1]);
    });
    for (const [ref, oid] of Object.entries(refs)) {
      const type = typeOf.get(oid);
      if (!type || type === "missing") throw new CorruptError("The repository's packs lack " + oid + ", the tip of " + ref);
      kinds[ref] = type;
    }
    const { peeled, peeledType } = await peelTags(children, repo, refs, kinds);
    for (const [tag, target] of Object.entries(base.peeled || {})) {
      if (peeled[tag] !== undefined && peeled[tag] !== target) throw new CorruptError("The manifest says tag " + tag + " peels to " + target + "; the objects say " + peeled[tag]);
    }
    const commitTips = [...new Set(Object.keys(refs).flatMap((ref) => (kinds[ref] === "commit" ? [refs[ref]] : peeledType[refs[ref]] === "commit" ? [peeled[refs[ref]]] : [])))];

    const outDir = path.join(dir, "out");
    await fsp.mkdir(outDir);
    const config = { ...PACK_CONFIG, "pack.packSizeLimit": "0", ...packConfig };
    const watching = reservation ? watchGrowth(reservation, children) : null;
    let hash;
    let history;
    try {
      [hash, history] = await Promise.all([
        packEverything({ children, repo, dir: outDir, tips, config }),
        commitTips.length ? packCommits({ children, repo, dir: outDir, tips: commitTips, config }) : null,
      ]);
    } catch (err) {
      throw (watching && watching.fail()) || err;
    } finally {
      if (watching) watching.stop();
    }
    if (watching) await watching.check();

    // Proofs. Nothing is uploaded until all hold.
    const main = await describePack(path.join(outDir, "all"), hash, "rewritten");
    for (const [ref, oid] of Object.entries(refs)) {
      if (!has(main.ids, oid)) throw new CorruptError("The rewritten pack lacks " + oid + ", the tip of " + ref);
    }
    for (const target of Object.values(peeled)) {
      if (!has(main.ids, target)) throw new CorruptError("The rewritten pack lacks " + target + ", the target of a tag");
    }
    await proveClosed({ children, dir, main, tips });

    let commits = null;
    if (history) {
      commits = await describePack(path.join(outDir, "history"), history.hash, "history");
      if (commits.objects !== history.commits.length) throw new CorruptError("The history pack holds " + commits.objects + " objects for " + history.commits.length + " commits");
      for (const oid of history.commits) {
        if (!has(commits.ids, oid)) throw new CorruptError("The history pack lacks the commit " + oid);
        if (!has(main.ids, oid)) throw new CorruptError("The rewritten pack lacks the commit " + oid);
      }
    }
    stats.gitMs += Date.now() - mark;

    const made = [main, ...(commits ? [commits] : [])];
    const after = { packs: made.length, bytes: bytesOf(made.map(entryOf)), objects: main.objects };
    let uploaded = [];
    if (!dryRun) {
      mark = Date.now();
      // Both settle before either failure is thrown, so no upload is still
      // reading scratch when scratch is deleted
      const uploads = await Promise.allSettled([upload(store, main, { rev: true }), commits ? upload(store, commits, { rev: false }) : null]);
      const failed = uploads.find((settled) => settled.status === "rejected");
      if (failed) throw failed.reason;
      uploaded = made.map((pack) => pack.name);
      stats.uploadMs += Date.now() - mark;
    }

    return { from: base, main: entryOf(main), history: commits ? entryOf(commits) : null, peeled, before, after, uploaded };
  } finally {
    for (const child of children) child.kill("SIGKILL");
    if (reservation) await reservation.release().catch((err) => console.error("Git store: could not remove scratch space", err));
    else if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch((err) => console.error("Git store: could not remove scratch space", err));
  }
}

// ---- Purging --------------------------------------------------------------

// The pack files the store holds, by pack name: { ext: { key, size,
// lastModified } }
async function listPacks(store) {
  const packs = new Map();
  for await (const item of store.list(PACK_PREFIX)) {
    const file = packFile(item.key);
    if (!file) continue;
    if (!packs.has(file.name)) packs.set(file.name, {});
    packs.get(file.name)[file.ext] = item;
  }
  return packs;
}

// The second a last-modified time falls in (S3 keeps whole seconds)
const second = (ms) => (Number.isFinite(ms) ? Math.floor(ms / 1000) : Infinity);

// Deletes, now, the packs the rewrite to manifest `ours` (already swapped in,
// read from the store or returned by the swap) left behind: every pack (.pack,
// .idx and .rev; history packs and pieces too) that neither `ours` nor any
// manifest after it names, and whose files were all last written in a second
// before the one `ours` was created in (by the store's clock, from a HEAD of
// it), and the sweep's record (sweep/pending.json), whose marks are for packs
// that are gone now or will be marked again.
//
// Manifests are not touched. The older ones hold refs and object IDs, never
// content, so they leak nothing that was scrubbed; they stay for the sweep,
// which deletes them in order once they leave its recovery window, as always,
// so nothing manifest.swap's guards rely on changes. Until then they name
// packs that are gone, which the sweep takes as already deleted. One must not
// be put back by hand.
//
// Which writers this can race: one whose base is `ours` or later read it after
// it was created, so what it uploads is later and is left alone (for the
// sweep, if it never swaps). One whose base came before `ours` can no longer
// swap what it uploaded: receive refuses, and commit and compaction start again
// or give up, when the epoch they built on is not the newest manifest's.
//
// Just before a pack's files are deleted the manifests are read forward from
// the newest seen (a HEAD for the next seq, a GET of any found), and a pack
// one names is spared; then each file in turn is HEADed, spared if it was
// written since the cutoff, and deleted at once, so the time between the
// check and the DELETE is one round trip; and the newest manifest is asserted
// not to name it (code PURGE_REFERENCED, which can only fire on a bug), as
// the sweep does. What is left is the sweep's own race: a writer that uploads
// the very same bytes (packs are named by content) between a file's HEAD and
// its DELETE and then names the pack. The object store has no DELETE
// conditional on the last-modified time, so it cannot be closed here; instead,
// once done, the newest manifest is read again and every .pack and .idx it
// names is HEADed, and any that is missing is reported in `missing`
// (rewriteRepo then answers "damaged"). Pushing again from a clone repairs it.
//
// A clone or fetch still streaming an old pack fails part way, with an error
// to its client, which tries again against the new manifest. That is the cost
// of deleting now, and why purging is the operator's choice. Safe to run
// again: what is gone is skipped.
//
// Resolves with { packs, bytes, spared, missing }: the packs deleted, their
// files' bytes, the packs left because they were written after the rewrite,
// and the names of packs the newest manifest names whose files are missing.
async function purge({ store, ours }) {
  const result = { packs: 0, bytes: 0, spared: 0, missing: [] };
  const created = await store.head(manifestKey(ours.seq));
  if (!created) throw new Error("The rewritten manifest " + manifestKey(ours.seq) + " is not in the store");
  const cutoff = second(created.lastModified);

  const named = new Set(manifest.packsNamed(ours));
  let newest = ours;
  async function readForward() {
    while (await store.head(manifestKey(newest.seq + 1))) {
      const next = manifest.parse(await store.get(manifestKey(newest.seq + 1), { maxBytes: manifest.MAX_BYTES }));
      if (next.seq !== newest.seq + 1) throw new CorruptError(manifestKey(newest.seq + 1) + " says it is seq " + next.seq);
      newest = next;
      for (const name of manifest.packsNamed(newest)) named.add(name);
    }
  }
  await readForward();

  for (const [name, listed] of await listPacks(store)) {
    if (named.has(name)) continue;
    if (Object.values(listed).some((file) => !(second(file.lastModified) < cutoff))) {
      result.spared++;
      continue;
    }

    await readForward();
    if (named.has(name)) continue;
    if (manifest.packsNamed(newest).includes(name)) {
      throw coded("The purge was about to delete " + name + ", which the newest manifest (seq " + newest.seq + ") names", "PURGE_REFERENCED");
    }

    // A HEAD and then the DELETE, a file at a time, so each check is as
    // close to its DELETE as it can be. A file written since the cutoff
    // spares what is left of the pack (and what went is reported below, if
    // anything names it).
    let deleted = 0;
    let spared = false;
    for (const ext of EXTS) {
      const key = "packs/" + name + "." + ext;
      const found = await store.head(key);
      if (!found) continue;
      if (!(second(found.lastModified) < cutoff)) {
        spared = true;
        break;
      }
      await store.delete(key);
      deleted++;
      result.bytes += found.size;
    }
    if (spared) result.spared++;
    else if (deleted) result.packs++;
  }

  await store.delete(SWEEP_KEY);

  // The check after: everything the newest manifest names is there
  const latest = await manifest.read(store);
  for (const entry of namedEntries(latest)) {
    const [pack, idx] = await Promise.all([store.head(packKey(entry.name)), store.head(idxKey(entry.name))]);
    if (!pack || !idx) result.missing.push(entry.name);
  }
  return result;
}

// What purge() would do after a rewrite of `base` into `kept` (the names the
// new manifest would have): delete every pack but those. For a dry run.
async function planPurge(store, kept) {
  const plan = { packs: 0, bytes: 0 };
  for (const [name, listed] of await listPacks(store)) {
    if (kept.includes(name)) continue;
    plan.packs++;
    plan.bytes += Object.values(listed).reduce((sum, file) => sum + file.size, 0);
  }
  return plan;
}

// ---- The rewrite ----------------------------------------------------------

async function rewriteRepo({ store: objects, cache, lock, scratchDir = null, purge: purging = false, dryRun = false, pack = {}, clock = Date.now, attempts = ATTEMPTS }) {
  if (!dryRun && typeof lock !== "function") throw new Error("rewriteRepo needs the host's lock function");
  if (!scratchDir && !(cache && typeof cache.reserve === "function")) throw new Error("rewriteRepo needs a cache to reserve scratch space from, or a scratchDir");

  const started = Date.now();
  const { store, requests } = counting(objects);
  const stats = { ms: 0, attempts: 0, gitMs: 0, uploadMs: 0, swapMs: 0, purgeMs: 0, requests };
  const none = { packs: 0, bytes: 0, spared: 0, missing: [] };
  const finish = (result) => ({ ...result, stats: { ...stats, ms: Date.now() - started } });
  const report = (made) => ({
    before: made.before,
    after: made.after,
    dropped: { objects: made.before.objects - made.after.objects, bytes: made.before.bytes - made.after.bytes },
  });

  let current = await manifest.read(store, { clock });
  if (current.seq === 0) return finish({ outcome: "empty", seq: 0, epoch: "", purged: none });

  let made = null;
  for (let attempt = 1; ; attempt++) {
    stats.attempts = attempt;
    if (!made || !sameState(made.from, current)) {
      made = await make({ store, cache, scratchDir, base: current, packConfig: pack, dryRun, stats });
    }

    if (dryRun) {
      const result = { outcome: "dry-run", seq: current.seq, epoch: manifest.epochOf(current), ...report(made), purged: none };
      if (purging) result.wouldPurge = await planPurge(store, [made.main, made.history].filter(Boolean).map((p) => p.name));
      return finish(result);
    }

    const epoch = manifest.newEpoch();
    // On `current`, whose refs and head are those the packs were made from
    const next = manifest.rewritten(current, { epoch, pack: made.main, history: made.history, peeled: made.peeled });
    const mark = Date.now();
    try {
      await manifest.swap({ store, lock, base: current, next, uploaded: made.uploaded, clock });
    } catch (err) {
      stats.swapMs += Date.now() - mark;
      if (err instanceof OutcomeUnknownError) return finish({ outcome: "unknown", seq: next.seq, epoch, ...report(made), purged: none, error: err });
      if (!(err instanceof StaleManifestError)) throw err;
      if (attempt >= attempts) throw coded("The manifest moved " + attempts + " times while rewriting", "EMOVED", { cause: err });
      current = await manifest.read(store, { clock });
      continue;
    }
    stats.swapMs += Date.now() - mark;

    let purged = none;
    if (purging) {
      const at = Date.now();
      purged = await purge({ store, ours: next });
      stats.purgeMs = Date.now() - at;
    }
    // A pack the newest manifest names is missing: the purge lost the race
    // described at purge() (or something else deleted it)
    const outcome = purged.missing.length ? "damaged" : "rewritten";
    return finish({ outcome, seq: next.seq, epoch, ...report(made), purged });
  }
}

module.exports = rewriteRepo;
module.exports.purge = purge;
module.exports.ATTEMPTS = ATTEMPTS;
