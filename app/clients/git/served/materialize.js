// Brings a blog's folder from one commit to another, reading the git store
// (#2259). Only the files at the changed paths are touched: the folder has no
// checkout to maintain.
//
//   const paths = await materialize({ blogID, reader, from, to, log })
//
// reader is the store's (store/reader.js), from and to commit IDs (from may
// be null or the empty tree). Resolves with the paths which changed, without
// a leading slash and in NFC, for the sync to pass to Blot: both ends of a
// move.
//
// Files are written as the raw committed bytes, so .gitattributes rules such
// as eol and ident do not apply, and without the committed mode: the blog
// folder has no executable bit (storage/folder). Links and submodules are not
// written. Directories that a removal leaves empty are removed too, as `git
// reset --hard` would, but empty directories nothing here emptied are left
// alone.
//
// storage/folder names a file by its path in NFC. A name committed in another
// form (NFD, say) is therefore written under its NFC name, and a later change
// or removal of the same name in git acts on that same file.
//
// Paths come from history which may predate the checks a push goes through
// now, so a path is only used if it is safe: no empty, "." or ".." component,
// and no ".git" component, so nothing is written outside the folder and the
// folder's own .git directory is never touched. A symbolic link or file in
// the way of a path is replaced, never followed.
//
// Every change goes through storage/folder, straight from app/clients/git
// (not app/clients/folder.js, which would come back here), so the folder may
// be on disk or in the bucket (#2258):
//
//   - an exact rename (the same blob removed at one path and added at
//     another) is one move(), if neither path is inside the other and the
//     file there is still the old blob (its git blob ID, read back);
//     anything else is a removal and a write;
//   - then the removals, one at a time;
//   - then the writes, each streamed from the store's packs (reader.stream,
//     checked against the blob's ID as it goes, no temporary file). A blob
//     of up to SKIP_CHECK_BYTES is buffered first, and not written if the
//     file there already has its bytes: stat() for the size, and only when
//     that matches, stat({ sha1: true }), which on S3 costs nothing.
//
// The writes run WRITE_CONCURRENCY at a time, since each is an upload to the
// bucket and a few index reads, and one after another a push of 150 files
// spent most of its sync waiting on them. Their paths are all different, and
// each directory they need is made once, by whichever write gets there first
// (ensureDirectory's `made`), so two writes never both clear the same file
// out of a directory's way. models/file reads then writes its records, which
// is safe for writes at once only while no two of them share a field: if two
// paths are the same once folded as it folds them (names which differ in
// case or Unicode form, or a file and a directory of one name), the writes
// run one at a time, in order, as they always did, so the last one wins.
//
// What the writes hold at once: a blob of up to SKIP_CHECK_BYTES is buffered
// whole, and a delta-stored one of up to IN_MEMORY_DELTA_BYTES is built in
// memory with its base (each up to that size too), so the writes hold under
// about 100 MB however many files a push has. A bigger delta-stored blob is
// built in the reader's scratch space instead, which the reader does
// one at a time. A blob over SKIP_CHECK_BYTES goes to a spool file in the
// tmp directory before its upload (storage/folder), up to WRITE_CONCURRENCY
// of them at once, so tmp may hold that many large files together; the push
// limit bounds their total.
//
// A failure part way leaves the folder part applied and rejects; the sync
// runs the same range again, which ends where an uninterrupted run would.
const crypto = require("crypto");
const { Readable } = require("stream");
const storage = require("storage/folder");
const { parseCommit } = require("../store/objects");
const { diffTrees, EMPTY_TREE } = require("../store/treediff");
const { NotFoundError, CorruptError } = require("../store/errors");
const { mapLimit } = require("../store/limit");

const MODES = { 100644: true, 100755: true };
const SYMLINK = "120000";

// Blobs up to this size are compared with the file before being written
const SKIP_CHECK_BYTES = 1024 * 1024;

// How many files are written into the folder at once
const WRITE_CONCURRENCY = 8;

// The largest blob stored as a delta which a write builds in memory. Building
// one holds its base, its deltas and the result at once, and WRITE_CONCURRENCY
// writes may do so together, so a bigger one is built in the reader's scratch
// space instead, which the reader does one at a time
const IN_MEMORY_DELTA_BYTES = 4 * SKIP_CHECK_BYTES;

function safeParts(file) {
  const parts = file.split("/");

  for (const part of parts) {
    if (!part || part === "." || part === "..") return null;
    if (part.toLowerCase() === ".git") return null;
  }

  return parts;
}

// A blog-folder path from the parts of a path in the repository
function join(parts) {
  return "/" + parts.join("/");
}

// What is at a path: "directory", "file", "link" or null if nothing is. A
// link is reported as such only when the directories above the path are
// real ones, which the callers here have checked.
async function kind(blogID, file) {
  try {
    return (await storage.stat(blogID, file)).isDirectory
      ? "directory"
      : "file";
  } catch (err) {
    if (err.code === "ENOENT") return null;
    if (err.code === "ELOOP") return "link";
    throw err;
  }
}

async function makeDirectory(blogID, directory) {
  const found = await kind(blogID, directory);

  if (found === "directory") return;
  if (found) await storage.remove(blogID, directory);

  await storage.mkdir(blogID, directory);
}

// Makes the directory for the first parts of a path, with each directory made
// if it is missing. Something else in its place (a file, or a symbolic link,
// which is not followed) is removed to make room. `made` (optional) maps each
// directory this run has made sure of, by its name in NFC, to the promise
// doing so, so writes running at once make each one once.
async function ensureDirectory(blogID, parts, made) {
  for (let i = 1; i <= parts.length; i++) {
    const directory = join(parts.slice(0, i));

    if (!made) {
      await makeDirectory(blogID, directory);
      continue;
    }

    const key = directory.normalize("NFC");
    if (!made.has(key)) made.set(key, makeDirectory(blogID, directory));
    await made.get(key);
  }
}

// Removes a file, then the directories that this leaves empty. A directory in
// its place, or a symbolic link on the way to it, is not something to remove.
async function removeFile(blogID, parts) {
  if (
    parts.length > 1 &&
    (await kind(blogID, join(parts.slice(0, -1)))) !== "directory"
  )
    return;

  const found = await kind(blogID, join(parts));

  if (!found || found === "directory") return;

  await storage.remove(blogID, join(parts));

  for (let i = parts.length - 1; i > 0; i--) {
    const directory = join(parts.slice(0, i));
    let entries;

    try {
      entries = await storage.listNames(blogID, directory);
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }

    // Not empty, so it and the directories above it stay
    if (entries.length) return;

    await storage.rmdir(blogID, directory);
  }
}

async function treeOf(reader, commit) {
  if (!commit || commit === EMPTY_TREE) return null;

  const object = await reader.read(commit);
  if (!object)
    throw new NotFoundError("Commit " + commit + " is not in the repository");
  if (object.type !== "commit")
    throw new CorruptError(
      "Object " + commit + " is a " + object.type + ", not a commit"
    );

  return parseCommit(object.data).tree;
}

async function statOf(blogID, file, options) {
  try {
    return await storage.stat(blogID, file, options);
  } catch (err) {
    if (err.code === "ENOENT" || err.code === "ELOOP" || err.code === "ENOTDIR")
      return null;
    throw err;
  }
}

async function bufferOf(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Writes a blob to the file at `parts`, in place of whatever is there
async function writeBlob(blogID, reader, parts, oid, stats, made) {
  const blob = await reader.stream(oid, { maxSize: IN_MEMORY_DELTA_BYTES });

  if (!blob)
    throw new NotFoundError(
      "Blob " + oid + " (" + parts.join("/") + ") is not in the repository"
    );
  if (blob.type !== "blob")
    throw new CorruptError(
      "Object " + oid + " is a " + blob.type + ", not a blob"
    );

  const file = join(parts);
  const stream = Readable.from(blob.data, { objectMode: false });
  let body = stream;

  try {
    if (blob.size <= SKIP_CHECK_BYTES) {
      // Read whole, which also checks it against its ID
      const bytes = await bufferOf(stream);
      const found = await statOf(blogID, file);

      if (found && !found.isDirectory && found.size === bytes.length) {
        const hashed = await statOf(blogID, file, { sha1: true });
        if (
          hashed &&
          hashed.sha1 === crypto.createHash("sha1").update(bytes).digest("hex")
        ) {
          stats.unchanged++;
          return;
        }
      }

      // A Buffer is uploaded as it is, with no spool file
      body = bytes;
    }

    await ensureDirectory(blogID, parts.slice(0, -1), made);
    if (await kind(blogID, file)) await storage.remove(blogID, file);
    await storage.write(blogID, file, body);
    stats.written++;
  } finally {
    stream.destroy();
  }
}

// Whether one path is the other, or a directory above it, as storage/folder
// names them (in NFC): a rename from a name's NFD form to its NFC form is the
// same file, and moving it onto itself would remove it, so it is a removal
// and a write
function nested(a, b) {
  const shorter = a.length <= b.length ? a : b;
  const longer = shorter === a ? b : a;
  return shorter.every(
    (part, i) => longer[i].normalize("NFC") === part.normalize("NFC")
  );
}

// Whether two writes name the same file or directory once their names are
// folded as models/file folds them for its lowercased lookup (NFC, then lower
// case), other than as the same directory spelled the same way: a file and a
// directory at one path, two spellings of a name, or one path twice
function overlapping(writes) {
  const seen = new Map();

  function clashes(names, isFile) {
    const exact = names.join("/");
    const folded = exact.toLowerCase();
    const found = seen.get(folded);

    if (!found) {
      seen.set(folded, { exact, isFile });
      return false;
    }

    return found.exact !== exact || found.isFile || isFile;
  }

  for (const { parts } of writes) {
    const names = parts.map((part) => part.normalize("NFC"));

    for (let i = 1; i < names.length; i++)
      if (clashes(names.slice(0, i), false)) return true;

    if (clashes(names, true)) return true;
  }

  return false;
}

// Whether the file at `parts` holds exactly the blob `oid`: its git blob ID,
// hashed as it is read, is that ID. Read through storage/folder (on S3, a
// download, which still saves the upload a write would be).
async function holds(blogID, parts, oid) {
  const file = join(parts);

  if ((await kind(blogID, file)) !== "file") return false;

  const found = await statOf(blogID, file);
  if (!found || found.isDirectory) return false;

  const hash = crypto.createHash("sha1").update("blob " + found.size + "\0");
  let size = 0;

  try {
    for await (const chunk of storage.createReadStream(blogID, file)) {
      size += chunk.length;
      if (size > found.size) return false;
      hash.update(chunk);
    }
  } catch (err) {
    if (
      err.code === "ENOENT" ||
      err.code === "ELOOP" ||
      err.code === "ENOTDIR" ||
      err.name === "NotFoundError"
    )
      return false;
    throw err;
  }

  return size === found.size && hash.digest("hex") === oid;
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

async function materialize({
  blogID,
  reader,
  from = null,
  to,
  log = function () {},
}) {
  const [a, b] = await Promise.all([treeOf(reader, from), treeOf(reader, to)]);
  const removals = [];
  const writes = [];
  const paths = [];
  const stats = { written: 0, unchanged: 0, moved: 0, removed: 0 };

  for await (const change of diffTrees({ reader, a, b })) {
    const parts = change.valid ? safeParts(change.path) : null;

    if (!parts) {
      log(
        "Skipping a path that is not safe to write: " +
          JSON.stringify(change.path)
      );
      continue;
    }

    if (change.newMode in MODES) {
      writes.push({
        parts,
        path: change.path,
        oid: change.newOid,
        added: !change.oldMode,
      });
    } else if (change.oldMode in MODES || change.oldMode === SYMLINK) {
      // Gone, or something we do not write (a link or submodule) in its place
      removals.push({
        parts,
        path: change.path,
        oid: change.oldMode in MODES && !change.newMode ? change.oldOid : null,
      });
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

    // One path inside the other (a/b.txt to a, or a to a/b.txt): making room
    // for the target would remove the source, so it is a removal and a write
    const at = candidates.findIndex(
      (removal) => !nested(removal.parts, write.parts)
    );
    if (at === -1) continue;

    const removal = candidates.splice(at, 1)[0];
    removal.moved = true;
    write.moved = true;
    moves.push({ removal, write });
  }

  // A file may become a directory of the same name, or the reverse: what goes
  // away is gone before anything comes in
  for (const { removal, write } of moves) {
    // Only a source which is the old blob is moved. One which is not there (a
    // run before this one got that far), or holds other bytes (a sync which
    // failed part way and left the folder ahead of the applied commit), is a
    // removal and a write from the store after all.
    if (!(await holds(blogID, removal.parts, removal.oid))) {
      removal.moved = false;
      write.moved = false;
      continue;
    }

    await moveFile(blogID, removal.parts, write.parts);
    stats.moved++;
  }

  for (const removal of removals) {
    if (removal.moved) continue;
    await removeFile(blogID, removal.parts);
    stats.removed++;
  }

  const pending = writes.filter((write) => !write.moved);
  // Overlapping names run one at a time, as they always did, and check each
  // directory afresh: one write may replace a directory an earlier one made
  // with a file (Å and Å/one.txt in another Unicode form), so a record of
  // directories already made would be stale
  const serial = overlapping(pending);
  const made = serial ? undefined : new Map();

  await mapLimit(pending, serial ? 1 : WRITE_CONCURRENCY, (write) =>
    writeBlob(blogID, reader, write.parts, write.oid, stats, made)
  );

  log("Applied from the store: " + JSON.stringify(stats));

  return paths;
}

module.exports = materialize;
module.exports.SKIP_CHECK_BYTES = SKIP_CHECK_BYTES;
module.exports.WRITE_CONCURRENCY = WRITE_CONCURRENCY;
module.exports.IN_MEMORY_DELTA_BYTES = IN_MEMORY_DELTA_BYTES;
module.exports.EMPTY_TREE = EMPTY_TREE;
