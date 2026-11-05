// Blot's own commits: one file written or removed, as one commit on master,
// in the object store. It makes the commits Blot's writes (repo.commit) have
// always made with git's plumbing on disk: the same identity and messages, the
// same refusals of paths, the same executable-bit rule, and no commit when
// nothing changes.
//
//   const result = await commit({ store, cache, lock, path: "/a/b.txt", contents });
//
//   store      the repository's object store (see objectStore/memory.js)
//   cache      the cache (cache.js): trees and commits go in it, so the next
//              commit does not read them back, and a large file's scratch
//              space is reserved from its budget
//   lock(fn)   the host's per-repository lock, passed to manifest.swap
//   path       the file's path as Blot knows it ("/a/b.txt"). It is normalised
//              as pathNormalizer does (unicode normal form C), and refused if
//              it has an empty part, ".", "..", ".git" in any case, or a NUL.
//   contents   a Buffer (or a string or typed array), or a readable stream
//   size       the stream's length in bytes, if the caller knows it. Git names
//              a blob by a hash that starts with its length, so a stream of
//              unknown length is first copied to scratch to count it.
//   remove     true to remove the file, or the folder of that name and
//              everything in it, instead of writing
//   identity   { name, email } of author and committer (default: the identity
//              the server's commits have always had)
//   now        the commit's time, a Date or milliseconds (default: now)
//   limit      the most bytes of contents accepted (default 2 GiB)
//
// The steps, in the order they run:
//
//   1. Hash the file's contents. A stream is deflated to scratch as it goes
//      (see below), so its size costs no memory.
//   2. Read the manifest, and from master's commit read only the trees along
//      the path, by range, or from the cache. Build the new trees and the
//      commit. If the root tree comes out the same as before, there is nothing
//      to commit: no pack is written and the store is not touched.
//   3. Write a pack of the new objects, every one stored whole (no deltas), so
//      the pack is self-contained. The file's contents are its last entry, so
//      every other entry starts near the front of the pack, and the .idx
//      never needs 8-byte offsets. Write its .idx and .rev, and a history
//      piece: a pack of just the commit and its .idx, which compaction merges
//      later (a piece is read whole, so it has no .rev).
//   4. Upload them all at once, then swap the manifest. A swap that lost to a push or to
//      another commit starts again from the new manifest, up to three
//      attempts and then EMOVED. If master has not moved (a tag was pushed,
//      say) the pack already uploaded is reused.
//   5. Put the new trees and the commit in the cache.
//
// Only the swap holds the host's lock. What makes a commit safe is the
// conditional create of the next manifest, as for a push (see manifest.js), so
// no lock needs to be held while a large file uploads.
//
// commit() resolves with
//
//   outcome   "ok"       the commit is saved, or there was nothing to commit
//             "unknown"  the swap may or may not have happened, and reading
//                        back to find out failed (OutcomeUnknownError). Not a
//                        success and not a failure: the caller must not
//                        advance anything that depends on the commit, nor
//                        repeat the write blindly. `error` is the cause.
//   commit    the new commit's ID, or null if nothing changed
//   parent    master's commit before it, or null
//   changed   whether a commit was made (null for "unknown")
//   seq       the manifest the commit made
//   manifest  that manifest itself (or the one read, if nothing changed), so
//             a host can plan a compaction without reading it again
//
// It throws for everything else, and then the manifest is as it was: an Error
// with code EPATH for a path refused, EMOVED for three lost swaps in a row, a
// TooLargeError, a NoRoomError when the cache has no room for a large file's
// scratch space, or whatever the object store threw.
//
// Memory: a Buffer is held whole (and one over 1 MiB is deflated to scratch
// like a stream). A stream is read in the chunks it gives, hashed and deflated
// as they arrive, and written to scratch, so memory does not grow with its
// size. The limit is `limit` (2 GiB, as for a push), and scratch has to hold
// the compressed contents (and, for a stream of unknown size, the contents
// themselves while they are counted), reserved from the cache as they arrive.
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const nodePath = require("path");
const zlib = require("zlib");
const { pipeline } = require("stream/promises");
const { Readable } = require("stream");
const { StaleManifestError, OutcomeUnknownError, CorruptError, TooLargeError } = require("./errors");
const { packKey, idxKey, revKey } = require("./layout");
const manifest = require("./manifest");
const createReader = require("./reader");
const { parseCommit } = require("./objects");
const { buildRev } = require("./rev");
const { noteSize } = require("./pack");
const { rememberWhole } = require("./idx");

const MASTER = "refs/heads/master";

// What the Docker image configures as the identity of any commit made on the
// server, and so who Blot's commits have always been by
const IDENTITY = { name: "Your Name", email: "you@example.com" };

// A commit made over a master which moved is made again on the new master,
// this many times
const ATTEMPTS = 3;

const MiB = 1024 * 1024;
const DEFAULT_LIMIT = 2048 * MiB;

// A Buffer up to this size is deflated in memory, and anything bigger goes
// through scratch
const MEMORY_BLOB = 1 * MiB;

// What scratch reserves before it knows more, and how much more it takes each
// time what has been written outgrows the reservation
const FIRST_RESERVE = 1 * MiB;
const RESERVE_STEP = 8 * MiB;

const TYPE_CODE = { commit: 1, tree: 2, blob: 3 };

const DIRECTORY = "40000";

const crc32 = zlib.crc32 ? (crc, buffer) => zlib.crc32(buffer, crc) : jsCrc32;

let crcTable = null;

// For a Node which lacks zlib.crc32 (before 22)
function jsCrc32(crc, buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = crcTable[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pathError(file) {
  return Object.assign(new Error("Cannot commit a file at this path: " + JSON.stringify(file)), { code: "EPATH" });
}

// The path of a file in the repository from the path Blot knows it by: the
// same steps as helper/pathNormalizer (which this directory may not require),
// then the rules Blot's writes have always had. Resolves with the parts,
// never empty.
function treePath(file) {
  if (typeof file !== "string") throw pathError(file);

  let p = file;
  if (p) {
    if (!p.startsWith("/")) p = "/" + p;
    if (!p.endsWith("/")) p = p + "/";
    p = p.trim().split("//").join("/");
    if (p.endsWith("/") && p !== "/") p = p.slice(0, -1);
    p = p.normalize();
  }

  const parts = p.slice(1).split("/");
  for (const part of parts) {
    if (!part || part === "." || part === ".." || part.toLowerCase() === ".git" || part.indexOf("\0") !== -1) throw pathError(file);
  }
  return parts;
}

function checkIdentity(identity) {
  for (const field of ["name", "email"]) {
    const value = identity && identity[field];
    if (typeof value !== "string" || !value || /[<>\n\0]/.test(value)) throw new Error("The commit's identity needs a name and an email without < > or newlines");
  }
}

function hashObject(type, body) {
  return crypto.createHash("sha1").update(type + " " + body.length + "\0").update(body).digest("hex");
}

// ---- Trees ------------------------------------------------------------

// The entries of a tree as they are stored, so a name which is not UTF-8 is
// written back exactly: { mode, name (Buffer), oid (Buffer), key }, where `key`
// is what git sorts by (a directory sorts as if its name ended in a slash)
function splitTree(buffer) {
  const entries = [];
  let at = 0;

  while (at < buffer.length) {
    const space = buffer.indexOf(32, at);
    const nul = space === -1 ? -1 : buffer.indexOf(0, space);
    if (nul === -1 || nul + 21 > buffer.length) throw new CorruptError("Invalid tree: an entry is cut short");

    const mode = buffer.toString("latin1", at, space);
    const name = buffer.subarray(space + 1, nul);
    entries.push({ mode, name, oid: buffer.subarray(nul + 1, nul + 21), key: sortKey(mode, name) });
    at = nul + 21;
  }
  return entries;
}

function sortKey(mode, name) {
  return mode === DIRECTORY ? Buffer.concat([name, Buffer.from("/")]) : name;
}

function joinTree(entries) {
  return Buffer.concat(entries.flatMap((e) => [Buffer.from(e.mode + " "), e.name, Buffer.from([0]), e.oid]));
}

// `entries` without anything called `name`, and with `replacement`
// ({ mode, oid (hex) }) under that name, if there is one
function withEntry(entries, name, replacement) {
  const kept = entries.filter((e) => !e.name.equals(name));
  if (replacement) {
    const oid = Buffer.from(replacement.oid, "hex");
    kept.push({ mode: replacement.mode, name, oid, key: sortKey(replacement.mode, name) });
  }
  return kept.sort((a, b) => Buffer.compare(a.key, b.key));
}

// ---- Packs ------------------------------------------------------------

// An object stored whole in a pack: its entry header, then its zlib stream
function entryHeader(type, size) {
  const bytes = [(TYPE_CODE[type] << 4) | (size & 15)];
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes[bytes.length - 1] |= 0x80;
    bytes.push(rest % 128);
    rest = Math.floor(rest / 128);
  }
  return Buffer.from(bytes);
}

function wholeEntry(type, body) {
  return { oid: hashObject(type, body), type, bytes: Buffer.concat([entryHeader(type, body.length), zlib.deflateSync(body)]) };
}

// The version 2 index of a pack: `entries` are { oid, offset, crc }
function buildIdx(entries, packChecksum) {
  const sorted = [...entries].sort((a, b) => (a.oid < b.oid ? -1 : 1));
  const fanout = Buffer.alloc(256 * 4);
  for (const e of sorted) for (let b = parseInt(e.oid.slice(0, 2), 16); b < 256; b++) fanout.writeUInt32BE(fanout.readUInt32BE(b * 4) + 1, b * 4);

  const crcs = Buffer.alloc(sorted.length * 4);
  const offsets = Buffer.alloc(sorted.length * 4);
  sorted.forEach((e, i) => {
    // The contents are the last entry, so this holds for any size of them
    if (e.offset >= 2 ** 31) throw new Error("A pack of Blot's own has an entry too far in for a 4-byte offset");
    crcs.writeUInt32BE(e.crc, i * 4);
    offsets.writeUInt32BE(e.offset, i * 4);
  });

  const body = Buffer.concat([Buffer.from([0xff, 0x74, 0x4f, 0x63, 0, 0, 0, 2]), fanout, ...sorted.map((e) => Buffer.from(e.oid, "hex")), crcs, offsets, packChecksum]);
  return Buffer.concat([body, crypto.createHash("sha1").update(body).digest()]);
}

// A pack of `smalls` (from wholeEntry, held in memory) and then, if there is
// one, `blob`: the contents, which may be in a file. Everything is stored
// whole. Resolves with what the manifest and the upload need:
//
//   { name, size, objects, idx, rev, body() }
//
// body() is the pack as a Buffer or, if the contents are in a file, a stream.
// The checksum is of the whole pack, so the pack is read once to find its name
// and again to upload; scratch keeps the file until the commit ends.
async function assemblePack(smalls, blob) {
  const count = smalls.length + (blob ? 1 : 0);
  const head = Buffer.alloc(12);
  head.write("PACK");
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(count, 8);

  const sha = crypto.createHash("sha1").update(head);
  const entries = [];
  let offset = 12;

  for (const small of smalls) {
    sha.update(small.bytes);
    entries.push({ oid: small.oid, offset, crc: crc32(0, small.bytes) });
    offset += small.bytes.length;
  }

  let tail = [];
  if (blob) {
    const header = entryHeader("blob", blob.size);
    let crc = crc32(0, header);
    sha.update(header);

    if (blob.deflated) {
      crc = crc32(crc, blob.deflated);
      sha.update(blob.deflated);
    } else {
      for await (const chunk of fs.createReadStream(blob.file)) {
        crc = crc32(crc, chunk);
        sha.update(chunk);
      }
    }
    entries.push({ oid: blob.oid, offset, crc });
    offset += header.length + blob.compressedSize;
    tail = [header];
  }

  const checksum = sha.digest();
  const idx = buildIdx(entries, checksum);

  function body() {
    const front = [head, ...smalls.map((s) => s.bytes), ...tail];
    if (!blob || blob.deflated) return Buffer.concat([...front, ...(blob ? [blob.deflated] : []), checksum]);

    return Readable.from(
      (async function* () {
        yield* front;
        yield* fs.createReadStream(blob.file);
        yield checksum;
      })()
    );
  }

  return { name: "pack-" + checksum.toString("hex"), size: offset + 20, objects: count, idx, rev: buildRev(idx), body };
}

// ---- The file's contents ----------------------------------------------

const toChunk = (chunk) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

function createScratch(cache) {
  let reservation = null;
  let counter = 0;

  // The bytes of the files in scratch right now, which together are what the
  // reservation has to cover: the raw copy of a stream stays while the
  // deflated copy is written beside it
  const files = new Map();
  let live = 0;

  // Small caches take smaller steps
  const step = Math.max(1, Math.min(RESERVE_STEP, Math.floor(cache.maxBytes / 8)));

  return {
    // A file in scratch with `source` written into it, through the stream
    // `stages` (a compressor, say), within the budget and, if given, within
    // `limit` bytes written; resolves with the bytes written
    async write(source, { stages = [], limit = Infinity } = {}) {
      if (!reservation) reservation = await cache.reserve(FIRST_RESERVE);
      const file = nodePath.join(reservation.dir, "contents-" + ++counter);
      files.set(file, 0);

      async function* counted(chunks) {
        for await (const chunk of chunks) {
          const buffer = toChunk(chunk);
          files.set(file, files.get(file) + buffer.length);
          live += buffer.length;
          if (files.get(file) > limit) throw new TooLargeError("The file is larger than the " + limit + " bytes Blot accepts");
          if (live > reservation.bytes) await reservation.extend(Math.max(live - reservation.bytes, step));
          yield buffer;
        }
      }

      await pipeline(source, ...stages, counted, fs.createWriteStream(file));
      return { file, written: files.get(file) };
    },
    async remove(file) {
      await fsp.rm(file, { force: true });
      live -= files.get(file) || 0;
      files.delete(file);
    },
    async release() {
      if (reservation) await reservation.release().catch((err) => console.error("Git store: could not remove scratch space", err));
    },
  };
}

// The contents ready to go in a pack:
//
//   { oid, size, compressedSize, deflated | file }
//
// `deflated` is the compressed contents when small enough to hold, otherwise
// `file` in scratch is.
async function prepareBlob(contents, { scratch, limit, size }) {
  if (typeof contents === "string") contents = Buffer.from(contents, "utf8");
  else if (ArrayBuffer.isView(contents) && !Buffer.isBuffer(contents)) contents = Buffer.from(contents.buffer, contents.byteOffset, contents.byteLength);

  if (Buffer.isBuffer(contents)) {
    if (contents.length > limit) throw new TooLargeError("The file is larger than the " + limit + " bytes Blot accepts");
    const oid = hashObject("blob", contents);
    if (contents.length <= MEMORY_BLOB) {
      const deflated = zlib.deflateSync(contents);
      return { oid, size: contents.length, compressedSize: deflated.length, deflated };
    }
    return deflateToScratch([contents], contents.length, { scratch, limit });
  }

  if (!contents || typeof contents[Symbol.asyncIterator] !== "function") throw new Error("Cannot commit contents of this type");

  // A stream of unknown length is counted first
  let raw = null;
  if (size === undefined || size === null) {
    raw = await scratch.write(contents, { limit });
    size = raw.written;
    contents = fs.createReadStream(raw.file);
  }

  try {
    return await deflateToScratch(contents, size, { scratch, limit });
  } finally {
    if (raw) await scratch.remove(raw.file);
  }
}

// Hashes `chunks` as they pass and deflates them to a file in scratch. They
// must be exactly `size` bytes, because git names a blob by a hash which
// starts with its length.
async function deflateToScratch(chunks, size, { scratch, limit }) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("The size of the contents must be a whole number of bytes");
  if (size > limit) throw new TooLargeError("The file is larger than the " + limit + " bytes Blot accepts");

  const hash = crypto.createHash("sha1").update("blob " + size + "\0");
  let seen = 0;

  async function* hashed() {
    for await (const chunk of chunks) {
      const buffer = toChunk(chunk);
      seen += buffer.length;
      if (seen > size) throw new Error("The contents are longer than the " + size + " bytes they were said to be");
      hash.update(buffer);
      yield buffer;
    }
    if (seen !== size) throw new Error("The contents are " + seen + " bytes, not the " + size + " they were said to be");
  }

  const { file, written } = await scratch.write(Readable.from(hashed(), { objectMode: false }), { stages: [zlib.createDeflate()] });
  return { oid: hash.digest("hex"), size, compressedSize: written, file };
}

// ---- Reading the repository -------------------------------------------

// Commits and trees are read through the cache: the commit made last time and
// the trees along a path are the ones the next commit wants, and they never
// change, so a cached one needs no check beyond its hash.
//
// The reader keeps them in the cache by ID (see reader.js), checked against
// their ID when they come back.
function createObjects({ store, cache, base }) {
  const repo = createReader({ store, cache, manifest: base });

  return {
    put: (oid, type, body) => repo.remember(oid, type, body),
    async read(oid, wanted) {
      const found = await repo.read(oid);
      if (!found) throw new CorruptError("The repository has no object " + oid);
      if (found.type !== wanted) throw new CorruptError("Object " + oid + " is a " + found.type + ", not a " + wanted);
      return found.data;
    },
  };
}

// ---- The commit -------------------------------------------------------

// Builds the commit on top of master's, or returns null if the tree comes out
// as it was. Resolves with { parent, commit, objects } where `objects` are the
// new trees and the commit (not the contents), as { oid, type, body, bytes }.
async function build({ objects, parent, parts, blob, message, identity, when }) {
  const parentCommit = parent ? parseCommit(await objects.read(parent, "commit")) : null;

  // The trees along the path, from the root: what is stored, or nothing for a
  // directory which is not there (or is a file, which a write replaces)
  const levels = [];
  let treeOid = parentCommit ? parentCommit.tree : null;
  for (let depth = 0; depth < parts.length; depth++) {
    const entries = treeOid ? splitTree(await objects.read(treeOid, "tree")) : [];
    levels.push(entries);
    const name = Buffer.from(parts[depth]);
    const next = entries.find((e) => e.mode === DIRECTORY && e.name.equals(name));

    // Nothing is below a file, or below a directory which is not there, to
    // remove: as in git, that is no change, and the file is not touched
    if (!next && !blob && depth < parts.length - 1) return null;
    treeOid = next ? next.oid.toString("hex") : null;
  }

  const leaf = Buffer.from(parts[parts.length - 1]);
  const existing = levels[levels.length - 1].find((e) => e.name.equals(leaf));

  // A file which is executable stays so
  const mode = existing && existing.mode === "100755" ? "100755" : "100644";

  const trees = [];
  let child = blob ? { mode, oid: blob.oid } : null;

  for (let depth = parts.length - 1; depth >= 0; depth--) {
    const entries = withEntry(levels[depth], Buffer.from(parts[depth]), child);

    // A directory with nothing left in it is not kept
    if (depth > 0 && entries.length === 0) {
      child = null;
      continue;
    }
    const body = joinTree(entries);
    const entry = wholeEntry("tree", body);
    trees.push({ ...entry, body });
    child = { mode: DIRECTORY, oid: entry.oid };
  }

  const tree = child.oid;
  if (parentCommit ? tree === parentCommit.tree : !blob) return null;

  const stamp = Math.floor(when / 1000) + " +0000";
  const person = identity.name + " <" + identity.email + "> " + stamp;
  const body = Buffer.from("tree " + tree + "\n" + (parent ? "parent " + parent + "\n" : "") + "author " + person + "\ncommitter " + person + "\n\n" + message + "\n");
  const entry = wholeEntry("commit", body);

  return { parent, commit: entry.oid, objects: [...trees, { ...entry, body }] };
}

// Uploads a pack with its index and, unless it is a history piece (read whole,
// so nothing wants its reverse index), its reverse index, all at once. Every
// upload has ended, one way or the other, before this settles.
async function uploadPack(store, pack, { rev = true } = {}) {
  const body = pack.body();
  const puts = [store.put(packKey(pack.name), body), store.put(idxKey(pack.name), pack.idx)];
  if (rev) puts.push(store.put(revKey(pack.name), pack.rev));
  const results = await Promise.allSettled(puts);
  if (body.destroy) body.destroy();
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
}

const entryOf = ({ name, size, idx, objects }) => ({ name, size, idxSize: idx.length, objects });

async function commit({ store, cache, lock, path: file, contents, size, remove = false, identity = IDENTITY, now = Date.now(), limit = DEFAULT_LIMIT }) {
  const parts = treePath(file);
  if (remove ? contents !== undefined && contents !== null : contents === undefined || contents === null) {
    throw new Error("A commit either writes contents or removes the path, not both and not neither");
  }
  checkIdentity(identity);

  const when = now instanceof Date ? now.getTime() : now;
  const message = (remove ? "Removed " : "Updated ") + parts.join("/");
  const scratch = createScratch(cache);

  try {
    const blob = remove ? null : await prepareBlob(contents, { scratch, limit, size });

    // What was built on one manifest and is reused if master did not move
    let built = null;
    let uploaded = null;

    for (let attempt = 1; ; attempt++) {
      const base = await manifest.read(store);
      const parent = base.refs[MASTER] || null;
      const objects = createObjects({ store, cache, base });

      if (!built || built.parent !== parent) {
        built = await build({ objects, parent, parts, blob, message, identity, when });
        uploaded = null;
      }
      // A rewrite landed since the upload: its purge may delete the pack, so
      // it is uploaded again. What was built still holds: it links only to
      // what master reaches, which a rewrite keeps.
      if (uploaded && uploaded.epoch !== manifest.epochOf(base)) uploaded = null;
      if (!built) return { outcome: "ok", commit: null, parent, changed: false, seq: base.seq, manifest: base };

      if (!uploaded) {
        const smalls = built.objects;
        const pack = await assemblePack(smalls, blob);
        const piece = await assemblePack(smalls.filter((o) => o.type === "commit"), null);

        // Every upload ends before this goes on, so none is still reading a
        // file from scratch when scratch is deleted
        const results = await Promise.allSettled([uploadPack(store, pack), uploadPack(store, piece, { rev: false })]);
        const failed = results.find((result) => result.status === "rejected");
        if (failed) throw failed.reason;
        uploaded = { pack, piece, epoch: manifest.epochOf(base) };

        // This process uploaded them, so it knows their size, and the next
        // reader of the pack needs no request for its index
        for (const p of [pack, piece]) noteSize(store, packKey(p.name), p.size);
        await rememberWhole({ cache, namespace: store.id, key: idxKey(pack.name), idx: pack.idx });
      }

      const next = manifest.advance(base, {
        refs: { ...base.refs, [MASTER]: built.commit },
        head: base.head || MASTER,
        packs: [entryOf(uploaded.pack)],
        historyPieces: [entryOf(uploaded.piece)],
      });

      try {
        await manifest.swap({ store, lock, base, next, uploaded: [uploaded.pack.name, uploaded.piece.name] });
      } catch (err) {
        if (err instanceof OutcomeUnknownError) return { outcome: "unknown", commit: built.commit, parent, changed: null, seq: next.seq, error: err };
        if (!(err instanceof StaleManifestError)) throw err;
        if (attempt >= ATTEMPTS) {
          throw Object.assign(new Error("master moved " + ATTEMPTS + " times while committing " + parts.join("/")), { code: "EMOVED" });
        }
        continue;
      }

      await Promise.all(built.objects.map((o) => objects.put(o.oid, o.type, o.body)));
      return { outcome: "ok", commit: built.commit, parent, changed: true, seq: next.seq, manifest: next };
    }
  } finally {
    await scratch.release();
  }
}

module.exports = commit;
module.exports.treePath = treePath;
