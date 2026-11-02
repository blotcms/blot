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
//   smallBase  the largest base stored as a delta that is resolved in memory
//              rather than in scratch (default 16 MiB); for specs to lower
//   sizeHint   how big the pack is expected to be (the Content-Length), so
//              the reservation starts near the right size; optional
//
// The steps, in the order they run:
//
//   1. Refuse commands which are not allowed (only master, and tags), before
//      reading the pack.
//   2. Stream the pack into scratch space reserved from the cache, so the
//      git disk budget stays one number. Stop at the limit. The manifest is
//      read meanwhile, and a push whose old values are out of date is refused
//      once the pack is in, before anything is checked.
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
//      each ref update's new tip exists, even when the push carried no objects,
//      and for each tip that is an annotated tag find what it finally points at
//      (the manifest's `peeled`, which the advertisement gives as a "^{}" line).
//   5. Build the .rev file, and a small pack of just the push's commits (a
//      history piece, which the manifest lists and compaction merges later).
//   6. Upload the pack, its .idx and .rev, and the history piece and its .idx
//      (a piece is read whole, so it has no .rev).
//   7. Swap the manifest, built on the one read in step 2 (the conditional
//      create decides whether it is still the newest). Only a swap that
//      landed is reported as a success. A swap lost to another writer is
//      tried again on the manifest that won
//      (up to three attempts in all): if a ref the push updates moved, the
//      push is refused; if the other writer changed other refs, or only packs
//      (compaction), the push is applied to the new manifest, with nothing
//      uploaded again.
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
//   manifest  that manifest itself, when it was ok, so a host can plan a
//             compaction (compact.plan) without reading it again
//   stats     { bytes, objects, basesFetched, packs }, for logs
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");
const { spawn } = require("child_process");
const { NoRoomError, StaleManifestError, OutcomeUnknownError, CorruptError, TooLargeError } = require("./errors");
const { packKey, idxKey, revKey } = require("./layout");
const { mapLimit, createSemaphore } = require("./limit");
const manifest = require("./manifest");
const createReader = require("./reader");
const { parseCommit, parseTree, parseTag, isDirectory, isGitlink } = require("./objects");
const { scanPack } = require("./packscan");
const { buildRev } = require("./rev");
const { noteSize } = require("./pack");
const { rememberWhole } = require("./idx");
const { readHistory } = require("./history");
const { ancestors } = require("./fetch");

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

// A base is streamed to scratch whatever its size. One stored as a delta is
// resolved in memory if it is up to SMALL_BASE (several at once, so this is the
// most memory a push's bases take, times CONCURRENCY), and otherwise is built
// in files in the push's reservation, one at a time. There is no limit on a
// base's size: the reservation, and so the cache's budget, is what bounds it.
const SMALL_BASE = 16 * MiB;

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

// Streams the pack into `file`, within the reservation and the limit. It is
// a pipeline, so a failure of the file (the disk full, say) rejects at once
// whatever the generator is waiting for, and nothing is left without a listener.
async function writeIncoming(incoming, reservation, cache, file, limit) {
  const step = Math.max(1, Math.min(RESERVE_STEP, Math.floor(cache.maxBytes / 8)));
  let bytes = 0;

  async function* chunks() {
    for (;;) {
      const next = await incoming.next();
      if (next.done) return;

      bytes += next.value.length;
      if (bytes > limit) throw new Refused("the push is larger than the " + formatSize(limit) + " Blot accepts");
      if (bytes > reservation.bytes) await reservation.extend(Math.max(bytes - reservation.bytes, Math.min(step, limit - reservation.bytes)));
      yield next.value;
    }
  }

  await pipeline(chunks(), fs.createWriteStream(file));
  return bytes;
}

// Lets the reader build delta-stored bases in files out of the push's own
// reservation, so the push's scratch space stays one number. Each request takes
// room from the reservation (extending it) and a directory inside it, and gives
// the room back when released. The reader builds one at a time, so several big
// bases do not reserve together.
function scratchFrom(reservation, cache) {
  let count = 0;

  // The push needs room it could never have, as opposed to room which is taken
  // just now: all it holds already (the pack, the other bases) and `bytes` more
  function mustFit(bytes) {
    if (reservation.bytes + bytes > cache.maxBytes) {
      const err = new TooLargeError("The push needs " + (reservation.bytes + bytes) + " bytes of scratch space and the cache holds " + cache.maxBytes);
      err.size = bytes;
      throw err;
    }
  }

  return {
    async reserve(bytes) {
      let held = 0;
      let released = false;
      const dir = path.join(reservation.dir, "expand-" + ++count);

      try {
        mustFit(bytes);
        await reservation.extend(bytes);
        held = bytes;
        await fsp.mkdir(dir);
      } catch (err) {
        reservation.shrink(held);
        throw err;
      }

      return {
        dir,
        async extend(more) {
          mustFit(more);
          await reservation.extend(more);
          held += more;
        },
        async release() {
          if (released) return;
          released = true;
          try {
            await fsp.rm(dir, { recursive: true, force: true });
          } finally {
            reservation.shrink(held);
          }
        },
      };
    },
  };
}

// A base which this push could never have the room for is a refusal: trying
// again will not help, unlike a cache which is full just now
function tooBig(size) {
  return new Refused(
    "the push builds on a file" + (size ? " of " + formatSize(size) : "") + " which is larger than Blot can currently handle. Please contact support."
  );
}

// Writes the objects `oids` that the store has as loose objects under `dir`,
// which index-pack reads as an alternate to complete the thin pack. Each is
// deflated as it streams, so a base costs no more memory than the chunk it is
// on, whatever its size and however it is stored. One stored as a delta
// (OFS_DELTA or REF_DELTA, possibly a chain) is resolved in memory if it is
// up to SMALL_BASE, and otherwise is built in files in the reservation (see the
// reader's `scratch`), whose size the reservation then counts. Resolves with
// { fetched: Set of IDs, bytes }.
async function fetchBases(repo, oids, dir, reservation, cache, smallBase) {
  const fetched = new Set();
  let bytes = 0;

  await mapLimit(oids, CONCURRENCY, async (oid) => {
    let found;
    try {
      found = await repo.stream(oid, { maxSize: smallBase });
    } catch (err) {
      if (err instanceof TooLargeError) throw tooBig(err.size);
      throw err;
    }
    if (!found) return;

    try {
      // Room for the loose copy here, and for the copy index-pack appends to the pack
      const need = 2 * found.size + 1024;
      if (reservation.bytes + need > cache.maxBytes) throw tooBig(found.size);
      await reservation.extend(need);
      const file = path.join(dir, oid.slice(0, 2), oid.slice(2));
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await pipeline(
        Readable.from(
          (async function* () {
            yield Buffer.from(found.type + " " + found.size + "\0");
            yield* found.data;
          })()
        ),
        zlib.createDeflate({ level: 1 }),
        fs.createWriteStream(file)
      );
    } finally {
      // A stream never started still holds the files it was built in
      if (found.data.return) await found.data.return().catch(() => {});
    }

    fetched.add(oid);
    bytes += found.size;
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
// trees and tags, and `listed` every object in the new pack (the fetched bases
// too, as Map(oid -> { type })). Only what the pack adds is checked: see the
// top of this file. Resolves with { missing, wrong }: the IDs that are
// nowhere, and those which are not the kind of object they are linked as
// (index-pack does not check links). Outside the pack that is a read of the
// object's header, not of its contents.
//
// An object outside the pack is looked up as soon as something links to it,
// while the walk goes on, rather than in a round of its own at the end.
async function findMissing({ repo, fresh, local, listed }) {
  const expected = new Map();
  const outside = new Map();
  const turn = createSemaphore(CONCURRENCY);
  const need = (oid, type) => {
    if (!expected.has(oid)) expected.set(oid, new Set());
    expected.get(oid).add(type);
    if (listed.has(oid) || outside.has(oid)) return;

    const lookup = (async () => {
      const done = await turn();
      try {
        return { type: await repo.typeOf(oid) };
      } catch (err) {
        return { err };
      } finally {
        done();
      }
    })();
    outside.set(oid, lookup);
  };
  const entryType = (entry) => (isDirectory(entry) ? "tree" : "blob");
  const visited = new Set();
  const trees = new Map();

  async function anyObject(oid) {
    return local.get(oid) || repo.read(oid);
  }

  async function readParent(oid) {
    try {
      return await anyObject(oid);
    } catch (err) {
      if (err instanceof TooLargeError) return null;
      throw err;
    }
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
    if (type === "tag") {
      const tag = parseTag(local.get(oid).data);
      need(tag.object, tag.type);
    }
    if (type !== "commit") continue;

    const commit = parseCommit(local.get(oid).data);
    commit.parents.forEach((parent) => need(parent, "commit"));
    need(commit.tree, "tree");

    // Merges are compared with their first parent. One too large to read just
    // means the new tree is checked in full, not that the push fails.
    const parent = commit.parents[0] ? await readParent(commit.parents[0]) : null;
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

        need(entry.oid, entryType(entry));
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
    for (const entry of parseTree(local.get(oid).data)) {
      if (isGitlink(entry)) continue;
      need(entry.oid, entryType(entry));
    }
  }

  const wrong = [...expected].filter(([oid, types]) => listed.has(oid) && (types.size > 1 || !types.has(listed.get(oid).type))).map(([oid]) => oid);

  // Outside the pack: there, and the kind of object it is linked as
  const missing = [];
  for (const [oid, lookup] of outside) {
    const { type, err } = await lookup;
    if (err) throw err;
    if (!type) missing.push(oid);
    else if (expected.get(oid).size > 1 || !expected.get(oid).has(type)) wrong.push(oid);
  }
  return { missing, wrong };
}

// Why each ref update's new tip can't be taken, as { ref: reason }: it isn't
// there, or a branch doesn't point at a commit. `types` (a Map) is filled with
// the type of each new tip, so the caller does not look them up again.
async function checkTips({ repo, commands, listed, types }) {
  const problems = {};

  for (const command of commands) {
    if (command.new === ZERO) continue;

    const type = listed.has(command.new) ? listed.get(command.new).type : await repo.typeOf(command.new);
    types.set(command.new, type);

    if (!type) problems[command.ref] = "missing necessary objects";
    else if (command.ref.indexOf("refs/heads/") === 0 && type !== "commit") problems[command.ref] = "branches must point to a commit";
  }

  return problems;
}

// How many tags deep a tag is peeled; a longer chain is not recorded
const MAX_PEEL = 16;

// For each new tip that is an annotated tag, the object it finally points at
// ({ tag oid: oid }), which the advertisement gives as its "^{}" line. The tag
// is in the push (`local`) or already in the repository. A tag that cannot be
// peeled is left out, and is advertised without a "^{}" line.
async function peelTags({ repo, local, types }) {
  const peeled = {};

  for (const [tip, type] of types) {
    if (type !== "tag") continue;

    let oid = tip;
    for (let depth = 0; depth < MAX_PEEL; depth++) {
      // Only a tag is read; the object it finally points at may be any size
      const known = local.get(oid);
      const type = known ? known.type : await repo.typeOf(oid);
      if (!type) break;
      if (type !== "tag") {
        peeled[tip] = oid;
        break;
      }
      const found = known || (await repo.read(oid));
      if (!found) break;
      oid = parseTag(found.data).object;
    }
  }

  return peeled;
}

// Uploads a pack with its index and, unless it is a history piece (which is
// only ever read whole, so nothing wants its reverse index), its reverse
// index, all at once. Every upload has ended, one way or the other, before this
// settles, so none is still reading a file from scratch when it is deleted.
async function uploadPack(store, piece, { rev = true } = {}) {
  const stream = fs.createReadStream(piece.packFile);
  stream.on("error", () => {}); // the upload sees it too, by reading the stream
  const puts = [store.put(packKey(piece.name), stream).finally(() => stream.destroy()), store.put(idxKey(piece.name), piece.idx)];
  if (rev) puts.push(store.put(revKey(piece.name), piece.rev));
  const failed = (await Promise.allSettled(puts)).find((put) => put.status === "rejected");
  if (failed) throw failed.reason;
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

async function receive({ store, cache, lock, commands, pack = null, limit = DEFAULT_LIMIT, sizeHint = 0, smallBase = SMALL_BASE, progress = null }) {
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
    // Git's 0000 probe, sent before a large request, has no commands. It is
    // answered, and touches nothing: no manifest, no scratch space.
    if (!commands.length) {
      await incoming.drain();
      return answer(commands, { outcome: "ok", extra: { stats } });
    }

    const problems = refusals(commands);
    if (Object.keys(problems).length) throw new Refused("ok", problems);
    if (sizeHint > limit) throw new Refused("the push is larger than the " + formatSize(limit) + " Blot accepts");

    // The manifest is read while the pack arrives. Work out of date is found
    // before anything is checked; the pack is still read to the end.
    const reading = manifest.read(store);
    reading.catch(() => {});

    const { base, added, repo, local } = await prepare({ store, cache, commands, incoming, limit, sizeHint, reading, children, stats, smallBase, hold: (r) => (reservation = r), say });
    const next = await swap({ store, cache, lock, commands, added, base });
    await remember({ store, cache, repo, added, local });

    stats.packs = added.packs.map((piece) => piece.name);
    say("Push saved.");
    return answer(commands, { outcome: "ok", extra: { seq: next.seq, manifest: next, stats } });
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

// Git's refusal when one ref's name is a directory in another's: with
// refs/tags/foo there can be no refs/tags/foo/bar. `refs` are the names that
// will exist after the push; the problems are for the refs it creates.
function nameConflicts(refs, commands) {
  const names = new Set(Object.keys(refs));
  const problems = {};

  for (const { ref, new: oid } of commands) {
    if (oid === ZERO) continue;

    const parts = ref.split("/");
    for (let i = 2; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      if (names.has(parent)) {
        problems[ref] = "cannot lock ref '" + ref + "': '" + parent + "' exists; cannot create '" + ref + "'";
        break;
      }
    }

    const child = [...names].find((name) => name.startsWith(ref + "/"));
    if (child && !problems[ref]) problems[ref] = "cannot lock ref '" + ref + "': '" + child + "' exists; cannot create '" + ref + "'";
  }

  return Object.keys(problems).length ? new Refused("ok", problems) : null;
}

// The refs as they will be once `commands` are applied to `current`'s
function applied(current, commands) {
  const refs = { ...current.refs };
  for (const command of commands) {
    if (command.new === ZERO) delete refs[command.ref];
    else refs[command.ref] = command.new;
  }
  return refs;
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
async function prepare({ store, cache, commands, incoming, limit, sizeHint, reading, children, stats, smallBase, hold, say }) {
  const added = { packs: [], pieces: [] };
  const needsPack = commands.some((command) => command.new !== ZERO);
  const reservation = await cache.reserve(Math.min(limit, Math.max(sizeHint, FIRST_RESERVE), Math.floor(cache.maxBytes / 2)));
  hold(reservation);

  const scratch = createScratch(reservation, children);
  const incomingFile = path.join(reservation.dir, "incoming.pack");
  const gitDir = path.join(reservation.dir, "repo.git");

  stats.bytes = needsPack ? await writeIncoming(incoming, reservation, cache, incomingFile, limit) : 0;
  await incoming.drain();

  const base = await reading;
  const behind = staleRefs(base, commands) || nameConflicts(applied(base, commands), commands);
  if (behind) throw behind;

  const repo = createReader({ store, cache, manifest: base, scratch: scratchFrom(reservation, cache) });

  // The commits the push replaces, and their root trees, are what the check
  // of the new commits compares with first, and each is usually the parent of
  // a new commit, which the check looks up in the packs. All of that is read
  // while the bases are fetched and the pack is indexed, rather than after.
  const prefetch = Promise.all(
    commands
      .filter((command) => command.old !== ZERO && command.new !== ZERO)
      .flatMap((command) => [
        repo.typeOf(command.old),
        repo.read(command.old).then((found) => found && found.type === "commit" && repo.read(parseCommit(found.data).tree)),
      ])
  ).catch(() => {});

  let fresh = new Map();
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
      const bases = await fetchBases(repo, wanted, basesDir, reservation, cache, smallBase);
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
      fresh = new Map([...listed].filter(([oid]) => !bases.fetched.has(oid)));
      stats.objects = fresh.size;

      const checked = [...fresh].filter(([, { type }]) => type !== "blob");
      if (checked.reduce((sum, [, { size }]) => sum + size, 0) > MAX_CHECKED_BYTES) {
        throw new Refused("the push has too many commits and directories for Blot to check");
      }
      local = await loadObjects(scratch, gitDir, checked.map(([oid]) => oid));

      say("Checking the new commits...");
      await prefetch;
      const { missing, wrong } = await findMissing({ repo, fresh, local, listed });
      if (wrong.length) {
        throw new Refused("ok", Object.fromEntries(commands.filter((c) => c.new !== ZERO).map((c) => [c.ref, "the push links to an object of the wrong type"])));
      }
      if (missing.length) {
        throw new Refused("ok", Object.fromEntries(commands.filter((c) => c.new !== ZERO).map((c) => [c.ref, "missing necessary objects"])));
      }

      added.packs.push(await describePack(path.join(packDir, packFile), path.join(packDir, packFile.replace(/\.pack$/, ".idx"))));

      const commits = [...fresh].filter(([, { type }]) => type === "commit");
      if (commits.length) added.pieces.push(await historyPiece(scratch, reservation, gitDir, commits));
    }
  }

  const types = new Map();
  const tips = await checkTips({ repo, commands, listed, types });
  if (Object.keys(tips).length) throw new Refused("ok", tips);
  added.peeled = await peelTags({ repo, local, types });
  await prefetch;

  // Nothing is acknowledged before this, and the manifest names no pack which
  // is not uploaded: a failure here leaves the repository as it was
  say("Saving to Blot...");

  // Every upload ends before this returns, so none is still reading a file
  // from scratch when scratch is deleted
  const uploads = await Promise.allSettled([...added.packs, ...added.pieces].map((piece) => uploadPack(store, piece, { rev: added.packs.includes(piece) })));
  const failed = uploads.find((upload) => upload.status === "rejected");
  if (failed) throw failed.reason;

  // This process uploaded them, so it knows their size
  for (const piece of [...added.packs, ...added.pieces]) noteSize(store, packKey(piece.name), piece.size);
  return { base, added, repo, local };
}

// The most bytes of a push's commits and trees kept in the cache after it
const REMEMBER_BYTES = 4 * MiB;

// Puts what the next push, commit or diff will want in the cache: the new
// packs' indexes, whole, and the push's commits and trees (up to
// REMEMBER_BYTES of them), which the next push compares its own with and often
// uses as delta bases. Each was written or checked here (index-pack wrote the
// indexes and hashed the objects). Only called once the swap has landed: the
// cache of objects holds only what the repository has, so a push's bases can
// come from it (see reader.js).
async function remember({ store, cache, repo, added, local }) {
  const indexes = added.packs.map((piece) => rememberWhole({ cache, namespace: store.id, key: idxKey(piece.name), idx: piece.idx }));
  let budget = REMEMBER_BYTES;
  const objects = [];
  for (const [oid, { type, data }] of local) {
    if (type === "blob" || data.length > budget) continue;
    budget -= data.length;
    objects.push(repo.remember(oid, type, data));
  }
  await Promise.all([...indexes, ...objects]);
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

// The packs to list again (with this push's seq) because the push makes
// objects reachable that no ref reached, which stay in whatever older pack
// holds them. A pack's seq is the push that last made its objects needed, and
// fetch sends the packs above a client's place by it. A push with a pack makes
// the same demand of the client (it sends what the refs it was shown did not
// reach), and a pack already listed is moved by manifest.advance. A push with no
// pack is the case left: a tip that is not a ref now and not an ancestor of one
// was last reachable some time ago. Which pack holds it is not known without
// reading, so all the packs are listed again, which costs the next fetch a
// clone and is rare (tagging a commit on a branch that was force pushed away).
async function reachedAgain({ store, cache, current, commands, added }) {
  if (added.packs.length) return [];

  const live = new Set(Object.values(current.refs));
  const tips = commands.filter((command) => command.new !== ZERO && !live.has(command.new)).map((command) => command.new);
  if (!tips.length) return [];

  const peel = (oid) => (current.peeled && current.peeled[oid]) || oid;
  // A tag object that is not a ref now is not reached by anything else
  if (tips.some((oid) => added.peeled[oid])) return current.packs;

  const graph = await readHistory({ store, cache, manifest: current });
  if (!graph) return current.packs;

  const reached = ancestors(graph, [...live].map(peel), Infinity);
  return tips.every((oid) => reached.has(oid)) ? [] : current.packs;
}

// How many times the swap is tried in all, as commit.js does
const ATTEMPTS = 3;

// Applies the commands to the newest manifest and swaps it in. The base may
// have moved since the push began (another push, Blot's own commit,
// compaction); that is fine as long as the refs the commands name have not.
// A swap lost to another writer's create is tried again on the manifest that
// won: the commands are checked against it, and only if a ref this push
// updates really moved is the push refused. The packs are already uploaded, so
// a retry is manifest work only (a read, perhaps the history for reachedAgain,
// and the create). Everything that depends on the base, `reachedAgain` and the
// manifest `advance` builds, is worked out again on the new one; what comes
// from the push alone (`added`, with its `peeled` targets, which are facts about
// immutable objects) is not. An uncontended push never gets here twice.
//
// The first attempt builds on `base`, the manifest read as the push began,
// whose refs were checked then: reading it again first would cost two round
// trips on every push to save one on a push which loses a race, and the
// create is what decides either way.
async function swap({ store, cache, lock, commands, added, base }) {
  const uploaded = [...added.packs, ...added.pieces].map((piece) => piece.name);

  for (let attempt = 1; ; attempt++) {
    const current = attempt === 1 ? base : await manifest.read(store);
    // A rewrite (rewrite.js) landed: it may have dropped objects this push's
    // check found in the repository, and its purge may delete the packs just
    // uploaded. The push is refused, as if its ref had moved, and the client
    // pushes again against the rewritten repository.
    if (manifest.epochOf(current) !== manifest.epochOf(base)) throw staleRefs(null, commands);
    const refs = applied(current, commands);
    const behind = staleRefs(current, commands) || nameConflicts(refs, commands);
    if (behind) throw behind;

    const again = await reachedAgain({ store, cache, current, commands, added });
    const next = manifest.advance(current, {
      refs,
      head: current.head || (refs[MASTER] ? MASTER : null),
      packs: (again.length ? again : added.packs).map(entryOf),
      historyPieces: added.pieces.map(entryOf),
      peeled: added.peeled,
    });

    try {
      await manifest.swap({ store, lock, base: current, next, uploaded, waitForHint: false });
      return next;
    } catch (err) {
      if (!(err instanceof StaleManifestError) || attempt >= ATTEMPTS) throw err;
    }
  }
}

module.exports = receive;
module.exports.refusal = refusal;
