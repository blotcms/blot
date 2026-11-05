// Imports a git repository that already exists on local disk (a bare repository
// or any git directory) into an empty store repository: one pack of everything
// reachable from its branches and tags, a history pack of its commits, and the
// first manifest, swapped in once. It is for the rewrite of Blot's existing
// repositories into the store, and for a blog whose folder already has files
// when it switches to the git client (the host runs `git init`, `add` and
// `commit` in scratch and imports that).
//
//   const result = await importRepo({ store, cache, lock, gitDir });
//
//   store       the repository's object store (see objectStore/memory.js)
//   cache       the cache (cache.js), whose budget the output pack's scratch
//               space is reserved from, as for a push or a compaction. Not
//               needed if scratchDir is given.
//   lock(fn)    the host's per-repository lock, passed to manifest.swap
//   gitDir      the git directory to read (`data/git/<handle>.git`). It is never
//               written: git is only asked to read it (for-each-ref, rev-list,
//               cat-file, pack-objects), and a spec checks that every file in
//               it is the same afterwards.
//   scratchDir  a directory to build the pack in instead of a reservation from
//               the cache, for a repository bigger than the cache (the rewrite
//               script on a host with a large local disk). Nothing is counted
//               against any budget; a directory of its own is made inside it and
//               removed in every case.
//   pack        git pack-objects' settings, over PACK_CONFIG (compact.js)
//   clock       the clock manifest.read and swap time the base by (an import
//               that outlasts manifest.MAX_BASE_AGE reads again and, if the
//               newest is still the same empty manifest, swaps on that); for specs
//
// The steps, in the order they run:
//
//   1. Read the newest manifest. Anything but an empty one (seq 0, or the
//      tombstone a removal leaves: manifest.isEmpty) is refused with code
//      ENOTEMPTY: a live repository is never overwritten.
//   2. Read the refs with `git for-each-ref`. Only refs/heads/* and refs/tags/*
//      are imported; everything else (refs/remotes, refs/stash, notes) is
//      listed in `skipped`, and so is a branch which does not point at a
//      commit. Work out `head` and the peeled target of each annotated tag.
//   3. Reserve scratch (or use scratchDir), then, at the same time,
//        - `git pack-objects --revs --delta-base-offset` (never --thin) writes
//          one pack of every object reachable from the refs, and
//        - `git rev-list` and `git pack-objects` write the history pack: every
//          commit reachable from them, and nothing else.
//      Objects the repository has that no branch or tag reaches (unreachable
//      objects, a stash, the objects behind refs/remotes) are left behind on
//      purpose; the source is still there if anyone wants them.
//   4. Prove both: the .idx lists the objects the header counts, no delta base
//      is outside the pack (packscan.js: every pack in a manifest must be
//      self-contained), every ref tip and every peeled target is in the main
//      pack, and every commit is in the history pack and in the main one.
//   5. Upload the pack, its .idx and .rev and the history pack and its .idx
//      (no .rev, as for a piece) at once. The packs stream from scratch to the
//      store, which uploads a large stream in parts, so memory does not depend
//      on the size of the repository.
//   6. Swap in the manifest after the empty one: seq 1, or the one after a
//      removal's tombstone (never 1 again: see remove.js). The conditional
//      create is the only thing that decides: if someone else wrote that seq
//      first the import fails with code EMOVED and is not retried (what was
//      uploaded is left for the sweep).
//
// A repository with nothing to import (no branch or tag) writes nothing and
// resolves { outcome: "empty" }. Otherwise it resolves
//
//   outcome   "imported"
//             "unknown"  the swap may or may not have happened and reading back
//                        failed (OutcomeUnknownError, as `error`), as for
//                        commit() and compact(): neither success nor failure.
//   seq       1, or the one after a removal's tombstone
//   head      the branch HEAD points at in the store, or null
//   refs      { name: oid } as imported
//   pack      { name, size, idxSize, objects }
//   history   { name, size, idxSize, commits } or null (no commit at all)
//   skipped   [{ ref, why }] for each ref left out
//   stats     { ms, gitMs (refs, packing and history), proveMs, uploadMs,
//               swapMs, bytesUp, requests: { total, heads, gets, puts,
//               putIfAbsents, ... } }. A put of a large stream is several
//               requests on S3 (a part each, plus the two that open and close
//               the upload); `requests` counts calls to the object store.
//
// It throws for anything else (ENOTEMPTY, EMOVED, a NoRoomError when the cache
// has no room for the scratch space, an upload that failed, a git failure, a
// CorruptError when a proof fails), and then the manifest is as it was.
//
// verifyImport() below is the check of an imported repository against its
// source, through the store's own clone code.
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { StaleManifestError, OutcomeUnknownError, CorruptError, NoRoomError } = require("./errors");
const { packKey, idxKey, revKey } = require("./layout");
const manifest = require("./manifest");
const { scanPack } = require("./packscan");
const { buildRev } = require("./rev");
const { clone } = require("./clone");
const { PACK_CONFIG, indexArgs, git: shared } = require("./compact");
const { runGit, idsOf, assertContains } = shared;
const { createChildren } = require("./limit");

const MiB = 1024 * 1024;

// Scratch beyond the pack itself: the history pack, git's temporary files
const SLACK = 4 * MiB;

// What an .idx costs for each object, near enough, for the estimate of scratch
const IDX_PER_OBJECT = 28;

// The refs a repository in the store has: the same as manifest.js accepts
const REF = /^refs\/(heads|tags)\/[^\s\x00-\x1f\x7f~^:?*[\\]+$/;
const OID = /^[0-9a-f]{40}$/;

function coded(message, code, extra) {
  return Object.assign(new Error(message), { code }, extra);
}

// The object store, counting what it is asked
function counting(store) {
  const requests = { total: 0 };
  const wrapped = { id: store.id };
  for (const name of ["head", "read", "get", "stream", "put", "putIfAbsent", "delete", "list"]) {
    wrapped[name] = (...args) => {
      const key = name === "putIfAbsent" ? "putIfAbsents" : name + "s";
      requests[key] = (requests[key] || 0) + 1;
      requests.total++;
      return store[name](...args);
    };
  }
  return { store: wrapped, requests };
}

// ---- Reading the source ---------------------------------------------------

// Runs git against the source. -c safe.directory lets a repository owned by
// another user be read (it only applies when given on the command line).
// --no-replace-objects: what is read is what is stored, not a replacement.
function sourceGit(children, gitDir, args, input) {
  return runGit(children, ["--no-replace-objects", "-c", "safe.directory=*", ...args], { gitDir, input });
}

// { refs: { name: oid }, kinds: { name: "commit" | "tag" | ... }, skipped, head }
// for the repository at gitDir
async function readRefs(children, gitDir) {
  const listing = await sourceGit(children, gitDir, ["for-each-ref", "--format=%(refname) %(objectname) %(objecttype)"]);
  const refs = {};
  const kinds = {};
  const skipped = [];

  for (const line of listing.split("\n")) {
    if (!line) continue;
    const [ref, oid, type] = line.split(" ");
    if (!OID.test(oid)) throw coded("The repository does not use SHA-1 object IDs: " + ref + " is " + oid, "EFORMAT");

    // git's output is decoded as UTF-8, which turns bytes that are not into
    // U+FFFD, so two different names could arrive as one. A name with U+FFFD
    // in it is skipped, whether it was decoded that way or really has one.
    if (ref.includes("\uFFFD")) skipped.push({ ref, why: "a name that is not valid UTF-8" });
    else if (!/^refs\/(heads|tags)\//.test(ref)) skipped.push({ ref, why: "only branches and tags are imported" });
    else if (!REF.test(ref) || ref.includes("..")) skipped.push({ ref, why: "the store does not accept this ref name" });
    else if (ref.startsWith("refs/heads/") && type !== "commit") skipped.push({ ref, why: "a branch which does not point at a commit" });
    else {
      refs[ref] = oid;
      kinds[ref] = type;
    }
  }

  // HEAD is the branch it names if that exists. Otherwise it is what a push
  // makes it (receive.js): master if there is one, else nothing.
  let head = null;
  try {
    const named = (await sourceGit(children, gitDir, ["symbolic-ref", "-q", "HEAD"])).trim();
    if (named in refs && named.startsWith("refs/heads/")) head = named;
  } catch (err) {}
  if (!head && refs["refs/heads/master"]) head = "refs/heads/master";

  return { refs, kinds, skipped, head };
}

// Each annotated tag is followed to what it finally points at, as a push does
// (the manifest's `peeled`), with its type, for the history pack. Asked of
// `repo`, the scratch repository, which sees the source's objects and none of
// its replace refs, grafts or shallow file.
async function peelTags(children, repo, refs, kinds) {
  const tagRefs = Object.keys(refs).filter((ref) => kinds[ref] === "tag");
  const peeled = {};
  const peeledType = {};
  if (tagRefs.length) {
    const tags = [...new Set(tagRefs.map((ref) => refs[ref]))];
    const out = await runGit(children, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { gitDir: repo, input: tags.map((oid) => oid + "^{}").join("\n") + "\n" });
    const lines = out.split("\n");
    tags.forEach((tag, i) => {
      const [target, type] = (lines[i] || "").split(" ");
      if (!OID.test(target) || type === "missing") throw coded("The tag " + tag + " does not lead to an object the repository has", "ECORRUPT");
      peeled[tag] = target;
      peeledType[tag] = type;
    });
  }
  return { peeled, peeledType };
}

// A guess at the bytes of the pack and its index, high rather than low, from
// what git counts: used to reserve scratch before the pack exists
async function estimate(children, gitDir, tips, maxBytes, alternates) {
  const counts = {};
  for (const line of (await sourceGit(children, gitDir, ["count-objects", "-v"])).split("\n")) {
    const [key, value] = line.split(": ");
    if (value !== undefined) counts[key] = Number(value);
  }

  const objects = (counts.count || 0) + (counts["in-pack"] || 0);
  const guess = ((counts.size || 0) + (counts["size-pack"] || 0)) * 1024 + objects * IDX_PER_OBJECT + SLACK;
  // count-objects does not count what is borrowed through alternates
  if (guess <= maxBytes && !alternates) return guess;

  // Loose objects are counted by the blocks they fill, which can be several
  // times what they hold. Before giving up, ask git what the reachable ones
  // really take (git 2.31 or later).
  try {
    const out = await sourceGit(children, gitDir, ["rev-list", "--objects", "--disk-usage", "--stdin"], tips.join("\n") + "\n");
    return Number(out.trim()) + objects * IDX_PER_OBJECT + SLACK;
  } catch (err) {
    // No better figure. With alternates the guess is not a bound, but the
    // reservation is checked as the pack grows (watchGrowth), so it is safe.
    return guess;
  }
}

// ---- Packing and proving --------------------------------------------------

function configArgs(packConfig) {
  return Object.entries(packConfig).flatMap(([key, value]) => ["-c", key + "=" + value]);
}

function has(ids, oid) {
  const want = Buffer.from(oid, "hex");
  let low = 0;
  let high = ids.length / 20;
  while (low < high) {
    const mid = (low + high) >> 1;
    const order = Buffer.compare(ids.subarray(mid * 20, mid * 20 + 20), want);
    if (order === 0) return true;
    if (order < 0) low = mid + 1;
    else high = mid;
  }
  return false;
}

// What a pack git wrote is: { name, size, idxSize, objects, packFile, idx, rev,
// ids }, after checking that its header counts what its index lists, that the
// two belong together, and that it is self-contained (every delta base is in
// it)
async function describePack(base, hash, label) {
  const packFile = base + "-" + hash + ".pack";
  const idx = await fsp.readFile(base + "-" + hash + ".idx");
  const handle = await fsp.open(packFile, "r");
  const head = Buffer.alloc(12);
  const trailer = Buffer.alloc(20);
  let size;
  try {
    ({ size } = await handle.stat());
    await handle.read(head, 0, 12, 0);
    await handle.read(trailer, 0, 20, size - 20);
  } finally {
    await handle.close();
  }

  const listed = idsOf(idx, label);
  if (head.readUInt32BE(8) !== listed.count) throw new CorruptError("The " + label + " pack's header does not count what its index lists");
  if (!idx.subarray(idx.length - 40, idx.length - 20).equals(trailer)) throw new CorruptError("The " + label + " pack's index is not of the pack");

  const scanned = await scanPack(packFile);
  if (scanned.count !== listed.count) throw new CorruptError("The " + label + " pack holds a different number of entries than its index lists");
  for (const oid of scanned.bases) assertContains(listed.ids, Buffer.from(oid, "hex"), "the " + label + " pack's own delta bases (it is not self-contained)");

  return { name: "pack-" + trailer.toString("hex"), size, idxSize: idx.length, objects: listed.count, packFile, idx, rev: buildRev(idx), ids: listed.ids };
}

// The pack of everything reachable from `tips`
async function packEverything({ children, repo, dir, tips, config }) {
  const args = [...configArgs(config), "pack-objects", "--revs", "--delta-base-offset", "-q", path.join(dir, "all")];
  const hash = (await runGit(children, args, { gitDir: repo, input: tips.join("\n") + "\n" })).trim();
  if (!hash) throw new CorruptError("git wrote no pack for the repository's refs");
  return hash;
}

// The pack of every commit reachable from `tips` (commits), and how many there
// are. A commit's pack holds only commits, which is what history.js reads.
async function packCommits({ children, repo, dir, tips, config }) {
  const commits = (await runGit(children, ["rev-list", "--stdin"], { gitDir: repo, input: tips.join("\n") + "\n" })).split("\n").filter(Boolean);
  const args = [...configArgs(config), "pack-objects", "--delta-base-offset", "-q", path.join(dir, "history")];
  const hash = (await runGit(children, args, { gitDir: repo, input: commits.join("\n") + "\n" })).trim();
  return { hash, commits };
}

// A bare repository in scratch which reads the source's objects through
// objects/info/alternates. Packing runs here, not in the source, for three
// reasons: git writes a pack it is making (a temporary file) into the object
// directory of the repository it runs in, and the source is never written;
// the source's replace refs, grafts, shallow file and config do not apply; and
// the output lands in scratch whatever else the source holds.
async function scratchRepo(children, dir, objects) {
  const repo = path.join(dir, "repo.git");
  await runGit(children, ["init", "-q", "--bare", repo], { gitDir: repo });
  await fsp.mkdir(path.join(repo, "objects", "info"), { recursive: true });
  await fsp.writeFile(path.join(repo, "objects", "info", "alternates"), objects + "\n");
  return repo;
}

// The source's object directory, which for a linked worktree's directory is
// the common repository's, not gitDir/objects
async function objectsDir(children, gitDir) {
  let common;
  try {
    // --path-format needs git 2.31
    common = (await sourceGit(children, gitDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  } catch (err) {
    common = path.resolve(gitDir);
  }
  return path.join(common, "objects");
}

function fileExists(file) {
  return fsp.stat(file).then(() => true, () => false);
}

// The bytes of everything under `dir` (git's temporary pack, the packs, the
// scratch repository)
async function sizeOf(dir) {
  let total = 0;
  for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await sizeOf(file);
    else total += await fsp.stat(file).then((stat) => stat.size, () => 0);
  }
  return total;
}

// Keeps a reservation at least as big as what git has written into its
// directory, extending it as the output grows. The estimate is only a guess,
// and git writes the pack without asking. If the cache has no room for the
// growth (NoRoomError), git is killed and the error is thrown. check() also
// settles the final size, and stops the watching.
function watchGrowth(reservation, children) {
  let failure = null;
  let busy = false;

  async function look() {
    if (busy || failure) return;
    busy = true;
    try {
      const used = await sizeOf(reservation.dir);
      if (used > reservation.bytes) await reservation.extend(used - reservation.bytes + SLACK);
    } catch (err) {
      failure = err;
      for (const child of children) child.kill("SIGKILL");
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(look, 50);
  return {
    async check() {
      clearInterval(timer);
      while (busy) await new Promise((resolve) => setTimeout(resolve, 5));
      await look();
      if (failure) throw failure;
    },
    stop() {
      clearInterval(timer);
    },
    fail: () => failure,
  };
}

// Proves the pack is closed: in a repository which holds only the pack (no
// alternates, no shallow file, no grafts, no replace refs), every object
// reachable from the tips is there, commits' parents and trees, trees' entries
// and tags' targets. A shallow or grafted source, or objects a source lacks,
// fail here, before anything is uploaded. It reads the .idx and the trees and
// commits, not the blobs' contents.
async function proveClosed({ children, dir, main, tips }) {
  const repo = path.join(dir, "closed.git");
  await runGit(children, ["init", "-q", "--bare", repo], { gitDir: repo });
  const packDir = path.join(repo, "objects", "pack");
  await fsp.mkdir(packDir, { recursive: true });
  const base = path.basename(main.packFile, ".pack");
  for (const ext of [".pack", ".idx"]) {
    const from = path.join(path.dirname(main.packFile), base + ext);
    await fsp.link(from, path.join(packDir, base + ext)).catch(() => fsp.copyFile(from, path.join(packDir, base + ext)));
  }
  try {
    await runGit(children, ["rev-list", "--objects", "--missing=error", "--count", "--stdin"], { gitDir: repo, input: tips.join("\n") + "\n" });
  } catch (err) {
    throw coded("The pack is not closed: objects the refs lead to are missing from it (" + err.message.slice(-300) + "). A shallow or grafted source, or one with missing objects, cannot be imported.", "ENOTCLOSED");
  }
  await fsp.rm(repo, { recursive: true, force: true });
}

// Uploads a pack, its index and (for the main pack) its reverse index at once.
// Every upload has ended before this settles, so none is still reading from
// scratch when scratch is deleted.
async function upload(store, pack, { rev }) {
  const stream = fs.createReadStream(pack.packFile);
  stream.on("error", () => {}); // the upload sees it too
  const puts = [store.put(packKey(pack.name), stream).finally(() => stream.destroy()), store.put(idxKey(pack.name), pack.idx)];
  if (rev) puts.push(store.put(revKey(pack.name), pack.rev));
  const failed = (await Promise.allSettled(puts)).find((put) => put.status === "rejected");
  if (failed) throw failed.reason;
}

const entryOf = ({ name, size, idxSize, objects }) => ({ name, size, idxSize, objects });

// ---- Import ---------------------------------------------------------------

async function importRepo({ store: objects, cache, lock, gitDir, scratchDir = null, pack = {}, estimateBytes = null, clock = Date.now, gate = null }) {
  if (typeof lock !== "function") throw new Error("importRepo needs the host's lock function");
  if (!gitDir) throw new Error("importRepo needs gitDir");
  if (!scratchDir && !(cache && typeof cache.reserve === "function")) throw new Error("importRepo needs a cache to reserve scratch space from, or a scratchDir");
  await fsp.stat(gitDir);

  const started = Date.now();
  const { store, requests } = counting(objects);
  const stats = { ms: 0, gitMs: 0, proveMs: 0, uploadMs: 0, swapMs: 0, bytesUp: 0, requests };
  const finish = () => {
    stats.ms = Date.now() - started;
    return stats;
  };

  // A shallow source has commits whose parents it does not have
  if ((await sourceGit(createChildren(gate), gitDir, ["rev-parse", "--is-shallow-repository"])).trim() === "true") {
    throw coded("The repository is shallow, so its history is incomplete. Only a complete repository can be imported.", "ESHALLOW");
  }

  const base = await manifest.read(store, { clock });
  if (!manifest.isEmpty(base)) {
    throw coded("The store repository already has a manifest (seq " + base.seq + "). An import only goes into an empty repository.", "ENOTEMPTY", { seq: base.seq });
  }

  const config = { ...PACK_CONFIG, "pack.packSizeLimit": "0", ...pack };
  const children = createChildren(gate);
  let reservation = null;
  let dir = null;

  try {
    let mark = Date.now();
    const found = await readRefs(children, gitDir);
    const { refs, kinds, skipped, head } = found;
    if (!Object.keys(refs).length) {
      stats.gitMs = Date.now() - mark;
      return { outcome: "empty", skipped, stats: finish() };
    }

    const tips = [...new Set(Object.values(refs))];
    const objectDir = await objectsDir(children, gitDir);

    // Scratch: a reservation from the cache (which fails with NoRoomError if
    // the repository could not fit in it), or a directory of the host's own
    if (scratchDir) {
      await fsp.mkdir(scratchDir, { recursive: true });
      dir = await fsp.mkdtemp(path.join(scratchDir, "import-"));
    } else {
      const alternates = await fileExists(path.join(objectDir, "info", "alternates"));
      const need = estimateBytes !== null ? estimateBytes : await estimate(children, gitDir, tips, cache.maxBytes, alternates);
      try {
        reservation = await cache.reserve(need);
      } catch (err) {
        if (err instanceof NoRoomError) err.message += " (a repository bigger than the cache can be imported with scratchDir, a directory on a larger disk)";
        throw err;
      }
      dir = reservation.dir;
    }

    const repo = await scratchRepo(children, dir, objectDir);
    const { peeled, peeledType } = await peelTags(children, repo, refs, kinds);
    const commitTips = [...new Set(Object.keys(refs).flatMap((ref) => (kinds[ref] === "commit" ? [refs[ref]] : peeledType[refs[ref]] === "commit" ? [peeled[refs[ref]]] : [])))];

    // The main pack and the history pack are independent; one git each. If
    // the output outgrows the reservation it is extended, or git is stopped.
    const watching = reservation ? watchGrowth(reservation, children) : null;
    let hash;
    let history;
    try {
      [hash, history] = await Promise.all([
        packEverything({ children, repo, dir, tips, config }),
        commitTips.length ? packCommits({ children, repo, dir, tips: commitTips, config }) : null,
      ]);
    } catch (err) {
      throw (watching && watching.fail()) || err;
    } finally {
      if (watching) watching.stop();
    }
    if (watching) await watching.check();
    stats.gitMs = Date.now() - mark;

    // Proofs. Nothing is uploaded until all hold.
    mark = Date.now();
    const main = await describePack(path.join(dir, "all"), hash, "imported");
    for (const ref of Object.keys(refs)) {
      if (!has(main.ids, refs[ref])) throw new CorruptError("The imported pack lacks " + refs[ref] + ", the tip of " + ref);
    }
    for (const target of Object.values(peeled)) {
      if (!has(main.ids, target)) throw new CorruptError("The imported pack lacks " + target + ", the target of a tag");
    }
    await proveClosed({ children, dir, main, tips });

    let commits = null;
    if (history) {
      commits = await describePack(path.join(dir, "history"), history.hash, "history");
      if (commits.objects !== history.commits.length) throw new CorruptError("The history pack holds " + commits.objects + " objects for " + history.commits.length + " commits");
      for (const oid of history.commits) {
        if (!has(commits.ids, oid)) throw new CorruptError("The history pack lacks the commit " + oid);
        if (!has(main.ids, oid)) throw new CorruptError("The imported pack lacks the commit " + oid);
      }
    }
    stats.proveMs = Date.now() - mark;

    mark = Date.now();
    // Both groups settle before either failure is thrown, so no upload is
    // still reading scratch when scratch is deleted
    const uploads = await Promise.allSettled([upload(store, main, { rev: true }), commits ? upload(store, commits, { rev: false }) : null]);
    const failedUpload = uploads.find((settled) => settled.status === "rejected");
    if (failedUpload) throw failedUpload.reason;
    stats.uploadMs = Date.now() - mark;

    const build = (on) =>
      manifest.advance(on, {
        refs,
        head,
        packs: [entryOf(main)],
        history: commits ? { ...entryOf(commits), through: on.seq + 1 } : null,
        peeled,
      });
    let next = build(base);
    stats.bytesUp = main.size + main.idxSize + main.rev.length + (commits ? commits.size + commits.idxSize : 0) + manifest.serialize(next).length;

    const result = {
      outcome: "imported",
      seq: next.seq,
      head,
      refs,
      pack: { name: main.name, size: main.size, idxSize: main.idxSize, objects: main.objects },
      history: commits ? { name: commits.name, size: commits.size, idxSize: commits.idxSize, commits: commits.objects } : null,
      skipped,
    };

    mark = Date.now();
    try {
      const uploaded = [main.name, ...(commits ? [commits.name] : [])];
      try {
        await manifest.swap({ store, lock, base, next, uploaded, clock });
      } catch (err) {
        // An import that took longer than a swap lets a base be held (a day)
        // reads the manifest again: still the same empty one, it swaps on
        // that, once. A newer empty one is a removal's tombstone, whose
        // removal may have deleted this import's uploads (which `uploaded`
        // would skip checking), so that is refused like any other change.
        if (!(err instanceof StaleManifestError) || manifest.isFresh(base, clock)) throw err;
        const fresh = await manifest.read(store, { clock });
        if (!manifest.isEmpty(fresh) || fresh.seq !== base.seq || manifest.epochOf(fresh) !== manifest.epochOf(base)) throw err;
        next = build(fresh);
        result.seq = next.seq;
        await manifest.swap({ store, lock, base: fresh, next, uploaded, clock });
      }
    } catch (err) {
      stats.swapMs = Date.now() - mark;
      if (err instanceof OutcomeUnknownError) return { ...result, outcome: "unknown", error: err, stats: finish() };
      if (err instanceof StaleManifestError) {
        throw coded("Another writer created the repository's first manifest while it was being imported. Nothing was imported or retried.", "EMOVED", { cause: err });
      }
      throw err;
    }
    stats.swapMs = Date.now() - mark;

    return { ...result, stats: finish() };
  } finally {
    for (const child of children) child.kill("SIGKILL");
    if (reservation) await reservation.release().catch((err) => console.error("Git store: could not remove scratch space", err));
    else if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch((err) => console.error("Git store: could not remove scratch space", err));
  }
}

// ---- Verifying an import -----------------------------------------------------

// Checks the store repository against the git directory it was imported from:
// clones it through the store's own clone code into scratch (a raw pack, as a
// client is sent), indexes it with `git index-pack --strict`, makes its refs,
// runs `git fsck --strict`, and compares every branch and tag, HEAD and every
// peeled tag with the source's. Resolves { refs, objects }; throws CorruptError
// saying what differs. Objects the source has that no branch or tag reaches
// are not expected to be there. `scratchDir` or `cache` as for importRepo; the
// scratch is the size of the clone.
async function verifyImport({ store, cache, gitDir, scratchDir = null, gate = null }) {
  const current = await manifest.read(store);
  if (manifest.isEmpty(current)) throw new CorruptError("The store repository is empty");

  const children = createChildren(gate);
  let reservation = null;
  let dir;

  try {
    if (scratchDir) {
      await fsp.mkdir(scratchDir, { recursive: true });
      dir = await fsp.mkdtemp(path.join(scratchDir, "verify-"));
    } else {
      reservation = await cache.reserve(current.packs.reduce((sum, pack) => sum + pack.size + pack.idxSize, 0) * 2 + SLACK);
      dir = reservation.dir;
    }

    const repo = path.join(dir, "clone.git");
    await runGit(children, ["init", "-q", "--bare", repo], { gitDir: repo });
    const packFile = path.join(repo, "objects", "pack", "clone.pack");
    await fsp.mkdir(path.dirname(packFile), { recursive: true });
    const out = fs.createWriteStream(packFile);
    const sent = await clone({ store, manifest: current, out });

    const inRepo = (args, input) => runGit(children, args, { gitDir: repo, input });
    await inRepo([...indexArgs(), "index-pack", "--strict", "--fsck-objects", packFile]);
    for (const [ref, oid] of Object.entries(current.refs)) await inRepo(["update-ref", ref, oid]);
    if (current.head) await inRepo(["symbolic-ref", "HEAD", current.head]);
    await inRepo([...indexArgs(), "fsck", "--strict", "--no-dangling"]);

    const mine = Object.fromEntries(
      (await inRepo(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"]))
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" "))
    );
    // The refs the import takes (one it skipped is not expected)
    const source = await readRefs(children, gitDir);
    const differences = [];
    for (const ref of new Set([...Object.keys(source.refs), ...Object.keys(mine)])) {
      if (mine[ref] !== source.refs[ref]) differences.push(ref + ": store " + mine[ref] + ", source " + source.refs[ref]);
    }
    if (differences.length) throw new CorruptError("The store's refs differ from the source's: " + differences.join("; "));
    if (source.head !== current.head) throw new CorruptError("The store's HEAD is " + current.head + "; the source's is " + source.head);

    const peeled = Object.entries(current.peeled || {});
    if (peeled.length) {
      const asked = peeled.map(([tag]) => tag + "^{}").join("\n") + "\n";
      const lines = (await inRepo(["cat-file", "--batch-check=%(objectname)"], asked)).split("\n");
      peeled.forEach(([tag, target], i) => {
        if (lines[i] !== target) throw new CorruptError("The manifest says tag " + tag + " peels to " + target + "; git says " + lines[i]);
      });
    }

    return { refs: Object.keys(mine).length, objects: sent.objects };
  } finally {
    for (const child of children) child.kill("SIGKILL");
    if (reservation) await reservation.release().catch(() => {});
    else if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = importRepo;
module.exports.verifyImport = verifyImport;
// For rewrite.js, which packs and proves what the refs reach in the same way
module.exports.internals = { counting, peelTags, describePack, packEverything, packCommits, proveClosed, watchGrowth, upload, has, entryOf, SLACK };
