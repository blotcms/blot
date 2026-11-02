// Receives a push: takes the ref updates a client sent and the pack that came
// with them, and either makes them the repository's new state in the object
// store or changes nothing. It does what Blot's receivePack.js does on disk,
// against the store: the same refusals and messages, and the same answer for
// the client to be told.
//
//   const result = await receive({ store, cache, lock, commands, pack });
//
//   store      the repository's object store (see objectStore/memory.js)
//   cache      the cache (cache.js), whose budget the push's scratch space is
//              reserved from
//   lock(fn)   the host's per-repository lock, passed to manifest.swap
//   commands   [{ old, new, ref }], as the client sent them
//   pack       an async iterable of Buffers: the rest of the request after the
//              commands. It may be empty or a pack with no objects.
//   limit      the most bytes of pack accepted (default 2 GiB)
//   progress   progress(message), called as each stage starts, with a line
//              for the blog's owner; see sideband.js for streaming it. Optional.
//   sizeHint   how big the pack is expected to be (the Content-Length), so
//              the reservation starts near the right size; optional
//
// The steps, in the order they run:
//
//   1. Refuse commands which are not allowed (only master, and tags) and
//      pushes whose old values are already out of date, before reading the pack.
//   2. Stream the pack into scratch space reserved from the cache, so the
//      git disk budget stays one number. Stop at the limit.
//   3. Find the objects the pack's deltas build on which it does not contain
//      (it is a thin pack), fetch them from the store in a batch, and have
//      `git index-pack --fix-thin --fsck-objects` complete and index the pack
//      in scratch. That is git's own check that every object is well formed.
//      (Not --strict: that also checks links, against a repository which is
//      not here. Links are checked in step 4.)
//   4. Check connectivity in JS. Every object already stored has everything it
//      points at stored too, so only what the new pack adds can be missing:
//      the parents and trees of its commits, the targets of its tags, and for
//      a tree only the entries which differ from the same place in its
//      commit's first parent. A root commit checks every entry. Then check that
//      each ref update's new tip exists, even when the push carried no objects.
//   5. Build the .rev file, and a small pack of just the push's commits (a
//      history piece, which the manifest lists and compaction merges later).
//   6. Upload the pack, its .idx and .rev, and the history piece.
//   7. Swap the manifest. Only a swap that landed is reported as a success.
//
// Scratch space is released in every case, before receive() resolves.
//
// receive() resolves with what to tell the client; it does not throw (an
// error it did not expect is `error` on a "failed" result, for the host's log):
//
//   outcome   "ok"       the refs are updated
//             "refused"  nothing changed, and the client can fix it (a ref not
//                        allowed, a ref which moved, a bad pack, too big,
//                        missing objects); retrying the same push won't help
//             "failed"   nothing changed, and the fault is Blot's (no room,
//                        the store would not take an upload); retrying may help
//             "unknown"  the swap may or may not have happened, and reading
//                        back to find out failed. Not a success and not a
//                        failure: the client must be told so, and told to
//                        check the repository before pushing again.
//   status    "ok", or why the pack could not be unpacked (the report's
//             "unpack" line)
//   results   [{ ref, error? }], one for each command, as receivePack's
//   messages  lines to show the user
//   seq       the manifest the push made, when it was ok
//   stats     { bytes, objects, basesFetched, packs }, for logs
const fs = require("fs");
const fsp = require("fs/promises");
const { once } = require("events");
const path = require("path");
const zlib = require("zlib");
const { spawn } = require("child_process");
const { NoRoomError, StaleManifestError, OutcomeUnknownError, CorruptError, TooLargeError } = require("./errors");
const { packKey, idxKey, revKey } = require("./layout");
const { mapLimit } = require("./limit");
const manifest = require("./manifest");
const createReader = require("./reader");
const { parseCommit, parseTree, parseTag, isDirectory, isGitlink } = require("./objects");
const { scanPack } = require("./packscan");
const { buildRev } = require("./rev");

const ZERO = "0".repeat(40);
const MASTER = "refs/heads/master";

const MiB = 1024 * 1024;

const DEFAULT_LIMIT = 2048 * MiB;

// What a push reserves before it knows more, and how much more it takes each
// time what has arrived outgrows the reservation
const FIRST_RESERVE = 1 * MiB;
const RESERVE_STEP = 8 * MiB;

// How many objects are fetched or checked at once
const CONCURRENCY = 8;

// The commits, trees and tags of a push are held in memory to be checked.
// This is far more than any real push has.
const MAX_CHECKED_BYTES = 256 * MiB;

// How long one git command may run (a push can take an hour to arrive, but
// the commands here only start once it has)
const GIT_TIMEOUT_MS = 60 * 60 * 1000;

// A refusal of the whole push, or of particular refs: `status` is the report's
// "unpack" line, and `problems` says why for each ref ({ ref: reason })
class Refused extends Error {
  constructor(status, problems = {}) {
    super(status);
    this.problems = problems;
  }
}

// Git's rules for the names a push may create. Anything git itself would
// refuse is for the host to catch when it applies the refs.
function refNameProblem(ref) {
  if (ref.indexOf("refs/") !== 0) return "ref names must start with refs/";
  if (Buffer.byteLength(ref) > 1024) return "ref name is too long";
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(ref)) return "ref name has a character git does not allow";
  if (/\.\.|@\{|\/\/|\/$|\.$|^@$/.test(ref)) return "ref name is not valid";
  if (/(^|\/)\./.test(ref) || /\.lock(\/|$)/.test(ref)) return "ref name is not valid";
  return null;
}

// Why a command is not allowed, or null: the rules of receivePack.js. Blot
// syncs master, and tags are kept but do nothing; there are no other branches
// or kinds of ref.
function refusal(command) {
  const problem = refNameProblem(command.ref);
  if (problem) return "Push rejected: " + problem + ".";

  if (command.ref === MASTER) {
    if (command.new === ZERO) return "Push rejected: master cannot be deleted.";
    return null;
  }

  if (command.ref.indexOf("refs/heads/") === 0) {
    return "Push rejected: only the master branch is allowed. Please push to master or open a PR.";
  }

  if (command.ref.indexOf("refs/tags/") === 0) return null;

  return "Push rejected: only master and tags can be pushed.";
}

// What is wrong with the commands as a whole, as { ref: reason }
function refusals(commands) {
  const problems = {};
  const seen = new Set();

  for (const command of commands) {
    const reason = seen.has(command.ref) ? "ref given twice in one push" : refusal(command);
    seen.add(command.ref);
    if (reason) problems[command.ref] = reason;
  }

  return problems;
}

// The request body, which has to be read to the end whatever happens or the
// client would see its connection reset instead of the answer
function createIncoming(pack) {
  const iterator = pack ? pack[Symbol.asyncIterator]() : null;
  let done = !iterator;

  return {
    async next() {
      if (done) return { done: true };
      const next = await iterator.next();
      done = next.done;
      return next;
    },
    async drain() {
      try {
        while (!done) await this.next();
      } catch (err) {
        done = true;
      }
    },
  };
}

// The environment for git here: nothing from the host's own repositories or
// configuration reaches it
function gitEnvironment(extra) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith("GIT_")) env[name] = value;
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", ...extra };
}

function oneLine(text) {
  return String(text).replace(/[\r\n\0]+/g, " ").trim().slice(0, 1000);
}

// A line to show the user from what git wrote to stderr
function describeGitError(stderr) {
  const lines = stderr
    .split("\n")
    .map((line) => line.replace(/^(fatal|error): /, "").trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "git could not read the pack";
}

function formatSize(bytes) {
  return Math.max(1, Math.round(bytes / MiB)) + " MB";
}

function createScratch(reservation, children) {
  // Runs git; resolves with its stdout, or rejects with an Error carrying
  // `stderr`. `input` is a Buffer or string, `inputFile` a file to feed to
  // its stdin, and `outputFile` a file for its stdout (which then resolves "").
  function git(args, { gitDir, env = {}, input, inputFile, outputFile } = {}) {
    return new Promise((resolve, reject) => {
      const output = outputFile ? fs.openSync(outputFile, "w") : null;
      const child = spawn("git", args, {
        env: gitEnvironment({ ...(gitDir ? { GIT_DIR: gitDir } : {}), ...env }),
        stdio: ["pipe", output === null ? "pipe" : output, "pipe"],
      });
      const stdout = [];
      const stderr = [];
      let size = 0;
      const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);

      children.add(child);
      if (output !== null) fs.closeSync(output);
      if (child.stdout) child.stdout.on("data", (chunk) => stdout.push(chunk));
      child.stderr.on("data", (chunk) => {
        // Only the end of it is wanted: that is where git says what is wrong
        stderr.push(chunk);
        size += chunk.length;
        while (size > 16 * 1024 && stderr.length > 1) size -= stderr.shift().length;
      });
      child.stdin.on("error", () => {});
      child.on("error", (err) => {
        clearTimeout(timer);
        children.delete(child);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        children.delete(child);
        if (code === 0) return resolve(Buffer.concat(stdout));
        const err = new Error("git " + args.join(" ") + " failed: " + oneLine(Buffer.concat(stderr).toString()));
        err.stderr = Buffer.concat(stderr).toString();
        reject(err);
      });

      if (inputFile) fs.createReadStream(inputFile).on("error", () => child.kill("SIGKILL")).pipe(child.stdin);
      else child.stdin.end(input || "");
    });
  }

  return { dir: reservation.dir, git };
}

// Streams the pack into `file`, within the reservation and the limit
async function writeIncoming(incoming, reservation, cache, file, limit) {
  const out = fs.createWriteStream(file);
  const step = Math.max(1, Math.min(RESERVE_STEP, Math.floor(cache.maxBytes / 8)));
  let bytes = 0;

  try {
    for (;;) {
      const next = await incoming.next();
      if (next.done) break;

      bytes += next.value.length;
      if (bytes > limit) throw new Refused("the push is larger than the " + formatSize(limit) + " Blot accepts");
      if (bytes > reservation.bytes) await reservation.extend(Math.max(bytes - reservation.bytes, Math.min(step, limit - reservation.bytes)));
      if (!out.write(next.value)) await once(out, "drain");
    }
    out.end();
    await once(out, "close");
  } catch (err) {
    out.destroy();
    throw err;
  }

  return bytes;
}

// Writes the objects `oids` that the store has as loose objects under `dir`,
// which index-pack reads as an alternate to complete the thin pack. Resolves
// with { fetched: Set of IDs, bytes }.
async function fetchBases(repo, oids, dir, reservation) {
  const fetched = new Set();
  let bytes = 0;

  await mapLimit(oids, CONCURRENCY, async (oid) => {
    const found = await repo.read(oid);
    if (!found) return;

    // Room for the loose copy here, and for the copy index-pack appends to the pack
    await reservation.extend(2 * found.data.length + 1024);
    const file = path.join(dir, oid.slice(0, 2), oid.slice(2));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, zlib.deflateSync(Buffer.concat([Buffer.from(found.type + " " + found.data.length + "\0"), found.data]), { level: 1 }));

    fetched.add(oid);
    bytes += found.data.length;
  });

  return { fetched, bytes };
}

// What a pack file is, for the manifest: the name its checksum gives it, its
// size and object count, and its index
async function describePack(packFile, idxFile) {
  const handle = await fsp.open(packFile, "r");
  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(12);
    const trailer = Buffer.alloc(20);
    await handle.read(header, 0, 12, 0);
    await handle.read(trailer, 0, 20, size - 20);

    const idx = await fsp.readFile(idxFile);
    return {
      name: "pack-" + trailer.toString("hex"),
      packFile,
      size,
      objects: header.readUInt32BE(8),
      idx,
      idxSize: idx.length,
      rev: buildRev(idx),
    };
  } finally {
    await handle.close();
  }
}

// Lists the objects of the repository in `gitDir` as Map(oid -> { type, size })
async function listObjects(scratch, gitDir) {
  const out = await scratch.git(["cat-file", "--batch-all-objects", "--batch-check"], { gitDir });
  const objects = new Map();
  for (const line of out.toString("latin1").split("\n")) {
    if (!line) continue;
    const [oid, type, size] = line.split(" ");
    objects.set(oid, { type, size: Number(size) });
  }
  return objects;
}

// The data of `oids` (commits, trees and tags), as Map(oid -> { type, data })
async function loadObjects(scratch, gitDir, oids) {
  const local = new Map();
  if (!oids.length) return local;

  const out = await scratch.git(["cat-file", "--batch"], { gitDir, input: oids.join("\n") + "\n" });
  let at = 0;
  while (at < out.length) {
    const eol = out.indexOf(10, at);
    const [oid, type, size] = out.toString("latin1", at, eol).split(" ");
    local.set(oid, { type, data: out.subarray(eol + 1, eol + 1 + Number(size)) });
    at = eol + 1 + Number(size) + 1;
  }
  return local;
}

// The IDs which the new objects point at and which are not in the new pack
// either, and which the repository does not have. `fresh` are the objects the
// push brought (Map(oid -> { type, size })), `local` the data of its commits,
// trees and tags, and `present` every ID in the new pack (the fetched bases
// too). Only what the pack adds is checked: see the top of this file.
async function findMissing({ repo, fresh, local, present }) {
  const toCheck = new Set();
  const visited = new Set();
  const trees = new Map();

  async function anyObject(oid) {
    return local.get(oid) || repo.read(oid);
  }

  async function entriesOf(oid) {
    if (!trees.has(oid)) {
      const found = await anyObject(oid);
      trees.set(oid, found && found.type === "tree" ? parseTree(found.data) : null);
    }
    return trees.get(oid);
  }

  let level = [];
  for (const [oid, { type }] of fresh) {
    if (type === "tag") toCheck.add(parseTag(local.get(oid).data).object);
    if (type !== "commit") continue;

    const commit = parseCommit(local.get(oid).data);
    commit.parents.forEach((parent) => toCheck.add(parent));
    toCheck.add(commit.tree);

    // Merges are compared with their first parent
    const parent = commit.parents[0] ? await anyObject(commit.parents[0]) : null;
    level.push({ a: parent && parent.type === "commit" ? parseCommit(parent.data).tree : null, b: commit.tree });
  }

  const seen = new Set();
  while (level.length) {
    level = level.filter((pair) => !seen.has(pair.a + ":" + pair.b) && seen.add(pair.a + ":" + pair.b));
    const next = [];

    await mapLimit(level, CONCURRENCY, async ({ a, b }) => {
      const newer = await entriesOf(b);
      if (!newer) return;
      visited.add(b);

      const before = new Map(((a && (await entriesOf(a))) || []).map((entry) => [entry.name, entry]));
      for (const entry of newer) {
        const was = before.get(entry.name);
        if (isGitlink(entry) || (was && was.oid === entry.oid && was.mode === entry.mode)) continue;

        toCheck.add(entry.oid);
        // A tree which is not in the pack is in the repository, and so closed
        if (isDirectory(entry) && fresh.has(entry.oid)) next.push({ a: was && isDirectory(was) ? was.oid : null, b: entry.oid });
      }
    });

    level = next;
  }

  // A tree in the pack which no commit led to (a client that sends more than
  // it needs to) has not been compared with anything, so all of it is checked
  for (const [oid, { type }] of fresh) {
    if (type !== "tree" || visited.has(oid)) continue;
    for (const entry of parseTree(local.get(oid).data)) if (!isGitlink(entry)) toCheck.add(entry.oid);
  }

  const missing = [];
  await mapLimit([...toCheck].filter((oid) => !present.has(oid)), CONCURRENCY, async (oid) => {
    if (!(await repo.has(oid))) missing.push(oid);
  });
  return missing;
}

// Why each ref update's new tip can't be taken, as { ref: reason }: it isn't
// there, or a branch doesn't point at a commit
async function checkTips({ repo, commands, listed }) {
  const problems = {};

  for (const command of commands) {
    if (command.new === ZERO) continue;

    let type = listed.has(command.new) ? listed.get(command.new).type : null;
    if (!type) {
      try {
        // A commit is small; anything bigger isn't one
        const found = await repo.read(command.new, { maxSize: MiB });
        type = found && found.type;
      } catch (err) {
        if (!(err instanceof TooLargeError)) throw err;
        type = "other";
      }
    }

    if (!type) problems[command.ref] = "missing necessary objects";
    else if (command.ref.indexOf("refs/heads/") === 0 && type !== "commit") problems[command.ref] = "branches must point to a commit";
  }

  return problems;
}

// Uploads a pack with its index and reverse index
async function uploadPack(store, piece) {
  const stream = fs.createReadStream(piece.packFile);
  try {
    await store.put(packKey(piece.name), stream);
  } finally {
    stream.destroy();
  }
  await store.put(idxKey(piece.name), piece.idx);
  await store.put(revKey(piece.name), piece.rev);
}

// The manifest entry for an uploaded pack
const entryOf = ({ name, size, idxSize, objects }) => ({ name, size, idxSize, objects });

function answer(commands, { outcome, status = "ok", problems = {}, messages = [], extra = {} }) {
  const stopped = outcome !== "ok";
  const results = commands.map((command) => {
    if (status !== "ok") return { ref: command.ref, error: outcome === "unknown" ? "outcome unknown" : "unpacker error" };
    if (problems[command.ref]) return { ref: command.ref, error: problems[command.ref] };
    if (stopped) return { ref: command.ref, error: "not updated because the rest of the push was refused" };
    return { ref: command.ref };
  });

  if (stopped && !messages.length) {
    messages = status !== "ok" ? ["Push failed: " + status] : Object.keys(problems).map((ref) => ref + ": " + problems[ref]);
  }
  if (stopped && outcome !== "unknown") messages = [...messages, "Nothing was pushed."];

  return { outcome, status, results, messages, ...extra };
}

async function receive({ store, cache, lock, commands, pack = null, limit = DEFAULT_LIMIT, sizeHint = 0, progress = null }) {
  // A host's callback must never be able to fail a push
  const say = (message) => {
    try {
      if (progress) progress(message);
    } catch (err) {}
  };
  const incoming = createIncoming(pack);
  const children = new Set();
  const stats = { bytes: 0, objects: 0, basesFetched: 0, packs: [] };
  let reservation = null;

  try {
    const problems = refusals(commands);
    if (Object.keys(problems).length) throw new Refused("ok", problems);
    if (sizeHint > limit) throw new Refused("the push is larger than the " + formatSize(limit) + " Blot accepts");

    // Work out of date before it is done: the pack is still read, below
    const base = await manifest.read(store);
    const behind = staleRefs(base, commands);
    if (behind) throw behind;

    const added = await prepare({ store, cache, commands, incoming, limit, sizeHint, base, children, stats, hold: (r) => (reservation = r), say });
    const next = await swap({ store, lock, commands, added });

    stats.packs = added.packs.map((piece) => piece.name);
    say("Push saved.");
    return answer(commands, { outcome: "ok", extra: { seq: next.seq, stats } });
  } catch (err) {
    await incoming.drain();
    return failure(commands, err, stats);
  } finally {
    for (const child of children) child.kill("SIGKILL");
    if (reservation) await reservation.release().catch((err) => console.error("Git store: could not remove scratch space", err));
  }
}

function failure(commands, err, stats) {
  if (err instanceof Refused) return answer(commands, { outcome: "refused", status: err.message, problems: err.problems, extra: { stats } });

  if (err instanceof StaleManifestError) {
    return answer(commands, { outcome: "refused", problems: staleRefs(null, commands).problems, extra: { stats } });
  }

  if (err instanceof OutcomeUnknownError) {
    return answer(commands, {
      outcome: "unknown",
      status: "Blot could not confirm whether the push was saved",
      messages: [
        "Blot could not confirm whether the push was saved. Run git fetch to see whether it was before you push again.",
      ],
      extra: { stats, error: err },
    });
  }

  const status =
    err instanceof NoRoomError
      ? "Blot has no room to receive this push right now; please try again in a moment"
      : "Blot hit an error receiving the push; please try again in a moment";
  return answer(commands, { outcome: "failed", status, extra: { stats, error: err } });
}

const MOVED = "the ref moved while you were pushing; pull and try again";

// A Refused for the commands whose old value is not what the manifest
// `current` holds, or null. Without a manifest, every command is stale.
function staleRefs(current, commands) {
  const stale = commands.filter((command) => !current || (current.refs[command.ref] || ZERO) !== command.old);
  if (!stale.length) return null;
  return new Refused("ok", Object.fromEntries(stale.map((command) => [command.ref, MOVED])));
}

// Everything up to the upload: the pack in scratch, completed and checked, its
// history piece, and both uploaded. Resolves with { packs, pieces } to name in
// the manifest (none, for a push of refs only).
async function prepare({ store, cache, commands, incoming, limit, sizeHint, base, children, stats, hold, say }) {
  const added = { packs: [], pieces: [] };
  const needsPack = commands.some((command) => command.new !== ZERO);
  const reservation = await cache.reserve(Math.min(limit, Math.max(sizeHint, FIRST_RESERVE), Math.floor(cache.maxBytes / 2)));
  hold(reservation);

  const scratch = createScratch(reservation, children);
  const repo = createReader({ store, cache, packs: base.packs });
  const incomingFile = path.join(reservation.dir, "incoming.pack");
  const gitDir = path.join(reservation.dir, "repo.git");

  stats.bytes = needsPack ? await writeIncoming(incoming, reservation, cache, incomingFile, limit) : 0;
  await incoming.drain();

  let fresh = new Map();
  let present = new Set();
  let local = new Map();
  let listed = new Map();

  // A request which carried no pack, or a pack with no objects, is a push of
  // refs to objects the repository has
  if (stats.bytes > 0) {
    say("Checking the pack...");
    let scanned;
    try {
      scanned = await scanPack(incomingFile);
    } catch (err) {
      if (err instanceof CorruptError) throw new Refused("the pack is not valid: " + err.message);
      throw err;
    }

    if (scanned.count > 0) {
      const wanted = [...scanned.bases].filter((oid) => !scanned.whole.has(oid));
      const basesDir = path.join(reservation.dir, "bases");
      await fsp.mkdir(basesDir, { recursive: true });
      if (wanted.length) say(wanted.length >= 100 ? "Fetching " + wanted.length + " files the push builds on..." : "Fetching files the push builds on...");
      const bases = await fetchBases(repo, wanted, basesDir, reservation);
      stats.basesFetched = bases.fetched.size;

      // The pack index-pack writes holds the pack, its bases and an index
      await reservation.extend(stats.bytes + scanned.count * 32 + 4096);
      await scratch.git(["init", "-q", "--bare", gitDir]);
      try {
        await scratch.git(["index-pack", "--stdin", "--fix-thin", "--fsck-objects"], {
          gitDir,
          inputFile: incomingFile,
          env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: basesDir },
        });
      } catch (err) {
        if (err.stderr === undefined) throw err;
        throw new Refused(describeGitError(err.stderr));
      }
      await fsp.rm(incomingFile);

      const packDir = path.join(gitDir, "objects", "pack");
      const files = await fsp.readdir(packDir);
      const packFile = files.find((file) => file.endsWith(".pack"));

      listed = await listObjects(scratch, gitDir);
      present = new Set(listed.keys());
      fresh = new Map([...listed].filter(([oid]) => !bases.fetched.has(oid)));
      stats.objects = fresh.size;

      const checked = [...fresh].filter(([, { type }]) => type !== "blob");
      if (checked.reduce((sum, [, { size }]) => sum + size, 0) > MAX_CHECKED_BYTES) {
        throw new Refused("the push has too many commits and directories for Blot to check");
      }
      local = await loadObjects(scratch, gitDir, checked.map(([oid]) => oid));

      say("Checking the new commits...");
      const missing = await findMissing({ repo, fresh, local, present });
      if (missing.length) {
        throw new Refused("ok", Object.fromEntries(commands.filter((c) => c.new !== ZERO).map((c) => [c.ref, "missing necessary objects"])));
      }

      added.packs.push(await describePack(path.join(packDir, packFile), path.join(packDir, packFile.replace(/\.pack$/, ".idx"))));

      const commits = [...fresh].filter(([, { type }]) => type === "commit");
      if (commits.length) added.pieces.push(await historyPiece(scratch, reservation, gitDir, commits));
    }
  }

  const tips = await checkTips({ repo, commands, listed });
  if (Object.keys(tips).length) throw new Refused("ok", tips);

  // Nothing is acknowledged before this, and the manifest names no pack which
  // is not uploaded: a failure here leaves the repository as it was
  say("Saving to Blot...");

  // Every upload ends before this returns, so none is still reading a file
  // from scratch when scratch is deleted
  const uploads = await Promise.allSettled([...added.packs, ...added.pieces].map((piece) => uploadPack(store, piece)));
  const failed = uploads.find((upload) => upload.status === "rejected");
  if (failed) throw failed.reason;
  return added;
}

// A pack of just these commits, for the history pack that compaction keeps
async function historyPiece(scratch, reservation, gitDir, commits) {
  const commitBytes = commits.reduce((sum, [, { size }]) => sum + size + 64, 0);
  await reservation.extend(commitBytes + 4096);

  const packFile = path.join(reservation.dir, "history.pack");
  await scratch.git(["pack-objects", "--stdout", "-q"], { gitDir, input: commits.map(([oid]) => oid).join("\n") + "\n", outputFile: packFile });
  await scratch.git(["index-pack", packFile], { gitDir });

  return describePack(packFile, path.join(reservation.dir, "history.idx"));
}

// Applies the commands to the newest manifest and swaps it in. The base may
// have moved since the push began (another push, Blot's own commit); that is
// fine as long as the refs the commands name have not.
async function swap({ store, lock, commands, added }) {
  const current = await manifest.read(store);
  const behind = staleRefs(current, commands);
  if (behind) throw behind;

  const refs = { ...current.refs };
  for (const command of commands) {
    if (command.new === ZERO) delete refs[command.ref];
    else refs[command.ref] = command.new;
  }

  const has = new Set(current.packs.map((pack) => pack.name));
  const next = manifest.advance(current, {
    refs,
    head: current.head || (refs[MASTER] ? MASTER : null),
    packs: added.packs.filter((piece) => !has.has(piece.name)).map(entryOf),
    historyPieces: added.pieces.map(entryOf),
  });

  await manifest.swap({ store, lock, base: current, next });
  return next;
}

module.exports = receive;
module.exports.refusal = refusal;
