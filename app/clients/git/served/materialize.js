// Brings a switched blog's folder from one commit to another, reading the
// git store (#2259) instead of the EBS repository. It treats the folder as
// app/clients/git/materialize.js does (the same safe paths, NFC names, raw
// committed bytes, directories a removal empties removed, links and
// submodules not written, anything in the way replaced and never followed),
// so the same commits give the same folder, whichever side was read.
//
//   const paths = await materialize({ blogID, reader, from, to, log })
//
// reader is the store's (store/reader.js), from and to commit IDs (from may
// be null or the empty tree). Resolves with the paths which changed, without
// a leading slash and in NFC, for the sync to pass to Blot: both ends of a
// move.
//
// Every change goes through storage/folder, one call at a time, straight
// from app/clients/git (not app/clients/folder.js, which would come back
// here), so the folder may be on disk or in the bucket (#2258):
//
//   - an exact rename (the same blob removed at one path and added at
//     another) is one move();
//   - then the removals;
//   - then the writes, each streamed from the store's packs (reader.stream,
//     checked against the blob's ID as it goes, no temporary file). A blob
//     of up to SKIP_CHECK_BYTES is buffered first, and not written if the
//     file there already has its bytes: stat() for the size, and only when
//     that matches, stat({ sha1: true }), which on S3 costs nothing.
//
// A failure part way leaves the folder part applied and rejects; the sync
// runs the same range again, which ends where an uninterrupted run would.
const crypto = require("crypto");
const { Readable } = require("stream");
const storage = require("storage/folder");
const { parseCommit } = require("../store/objects");
const { diffTrees } = require("../store/treediff");
const { NotFoundError, CorruptError } = require("../store/errors");
const { EMPTY_TREE, safeParts, kind, join, ensureDirectory, removeFile } = require("../materialize");

const MODES = { "100644": true, "100755": true };
const SYMLINK = "120000";

// Blobs up to this size are compared with the file before being written
const SKIP_CHECK_BYTES = 1024 * 1024;

async function treeOf(reader, commit) {
  if (!commit || commit === EMPTY_TREE) return null;

  const object = await reader.read(commit);
  if (!object) throw new NotFoundError("Commit " + commit + " is not in the repository");
  if (object.type !== "commit") throw new CorruptError("Object " + commit + " is a " + object.type + ", not a commit");

  return parseCommit(object.data).tree;
}

async function statOf(blogID, file, options) {
  try {
    return await storage.stat(blogID, file, options);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ELOOP" || err.code === "ENOTDIR") return null;
    throw err;
  }
}

async function bufferOf(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Writes a blob to the file at `parts`, in place of whatever is there
async function writeBlob(blogID, reader, parts, oid, stats) {
  const blob = await reader.stream(oid);

  if (!blob) throw new NotFoundError("Blob " + oid + " (" + parts.join("/") + ") is not in the repository");
  if (blob.type !== "blob") throw new CorruptError("Object " + oid + " is a " + blob.type + ", not a blob");

  const file = join(parts);
  let body = Readable.from(blob.data, { objectMode: false });

  try {
    if (blob.size <= SKIP_CHECK_BYTES) {
      // Read whole, which also checks it against its ID
      const bytes = await bufferOf(body);
      const found = await statOf(blogID, file);

      if (found && !found.isDirectory && found.size === bytes.length) {
        const hashed = await statOf(blogID, file, { sha1: true });
        if (hashed && hashed.sha1 === crypto.createHash("sha1").update(bytes).digest("hex")) {
          stats.unchanged++;
          return;
        }
      }

      body = Readable.from([bytes]);
    }

    await ensureDirectory(blogID, parts.slice(0, -1));
    if (await kind(blogID, file)) await storage.remove(blogID, file);
    await storage.write(blogID, file, body);
    stats.written++;
  } finally {
    body.destroy();
  }
}

// Moves the file at `from` to `to`, then removes the directories this leaves
// empty, as a removal would
async function moveFile(blogID, from, to) {
  await ensureDirectory(blogID, to.slice(0, -1));

  const target = join(to);
  if (await kind(blogID, target)) await storage.remove(blogID, target);

  await storage.move(blogID, join(from), target);

  for (let i = from.length - 1; i > 0; i--) {
    const directory = join(from.slice(0, i));
    let entries;

    try {
      entries = await storage.listNames(blogID, directory);
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }

    if (entries.length) return;
    await storage.rmdir(blogID, directory);
  }
}

async function materialize({ blogID, reader, from = null, to, log = function () {} }) {
  const [a, b] = await Promise.all([treeOf(reader, from), treeOf(reader, to)]);
  const removals = [];
  const writes = [];
  const paths = [];
  const stats = { written: 0, unchanged: 0, moved: 0, removed: 0 };

  for await (const change of diffTrees({ reader, a, b })) {
    const parts = change.valid ? safeParts(change.path) : null;

    if (!parts) {
      log("Skipping a path that is not safe to write: " + JSON.stringify(change.path));
      continue;
    }

    if (change.newMode in MODES) {
      writes.push({ parts, path: change.path, oid: change.newOid, added: !change.oldMode });
    } else if (change.oldMode in MODES || change.oldMode === SYMLINK) {
      // Gone, or something we do not write (a link or submodule) in its place
      removals.push({ parts, path: change.path, oid: change.oldMode in MODES && !change.newMode ? change.oldOid : null });
    } else {
      continue;
    }

    paths.push(change.path.normalize("NFC"));
  }

  // Exact renames: a file removed and the same bytes added at a new path
  const gone = new Map();
  for (const removal of removals) {
    if (!removal.oid) continue;
    if (!gone.has(removal.oid)) gone.set(removal.oid, []);
    gone.get(removal.oid).push(removal);
  }

  const moves = [];
  for (const write of writes) {
    const candidates = write.added && gone.get(write.oid);
    if (!candidates || !candidates.length) continue;
    const removal = candidates.shift();
    removal.moved = true;
    write.moved = true;
    moves.push({ from: removal.parts, to: write.parts });
  }

  // A file may become a directory of the same name, or the reverse: what goes
  // away is gone before anything comes in
  for (const move of moves) {
    // A move whose source is not there (a run before this one got that far)
    // is a write after all
    if ((await kind(blogID, join(move.from))) !== "file") {
      const write = writes.find((w) => w.parts === move.to);
      write.moved = false;
      continue;
    }

    await moveFile(blogID, move.from, move.to);
    stats.moved++;
  }

  for (const removal of removals) {
    if (removal.moved) continue;
    await removeFile(blogID, removal.parts);
    stats.removed++;
  }

  for (const write of writes) {
    if (write.moved) continue;
    await writeBlob(blogID, reader, write.parts, write.oid, stats);
  }

  log("Applied from the store: " + JSON.stringify(stats));

  return paths;
}

module.exports = materialize;
module.exports.SKIP_CHECK_BYTES = SKIP_CHECK_BYTES;
