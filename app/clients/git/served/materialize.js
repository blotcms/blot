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
// Every change goes through storage/folder, one call at a time, straight
// from app/clients/git (not app/clients/folder.js, which would come back
// here), so the folder may be on disk or in the bucket (#2258):
//
//   - an exact rename (the same blob removed at one path and added at
//     another) is one move(), if neither path is inside the other and the
//     file there is still the old blob (its git blob ID, read back);
//     anything else is a removal and a write;
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
const { diffTrees, EMPTY_TREE } = require("../store/treediff");
const { NotFoundError, CorruptError } = require("../store/errors");

const MODES = { "100644": true, "100755": true };
const SYMLINK = "120000";

// Blobs up to this size are compared with the file before being written
const SKIP_CHECK_BYTES = 1024 * 1024;

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
    return (await storage.stat(blogID, file)).isDirectory ? "directory" : "file";
  } catch (err) {
    if (err.code === "ENOENT") return null;
    if (err.code === "ELOOP") return "link";
    throw err;
  }
}

// Makes the directory for the first parts of a path, with each directory made
// if it is missing. Something else in its place (a file, or a symbolic link,
// which is not followed) is removed to make room.
async function ensureDirectory(blogID, parts) {
  for (let i = 1; i <= parts.length; i++) {
    const directory = join(parts.slice(0, i));
    const found = await kind(blogID, directory);

    if (found === "directory") continue;
    if (found) await storage.remove(blogID, directory);

    await storage.mkdir(blogID, directory);
  }
}

// Removes a file, then the directories that this leaves empty. A directory in
// its place, or a symbolic link on the way to it, is not something to remove.
async function removeFile(blogID, parts) {
  if (parts.length > 1 && (await kind(blogID, join(parts.slice(0, -1)))) !== "directory") return;

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

// Whether one path is the other, or a directory above it, as storage/folder
// names them (in NFC): a rename from a name's NFD form to its NFC form is the
// same file, and moving it onto itself would remove it, so it is a removal
// and a write
function nested(a, b) {
  const shorter = a.length <= b.length ? a : b;
  const longer = shorter === a ? b : a;
  return shorter.every((part, i) => longer[i].normalize("NFC") === part.normalize("NFC"));
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
    if (err.code === "ENOENT" || err.code === "ELOOP" || err.code === "ENOTDIR" || err.name === "NotFoundError") return false;
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

    // One path inside the other (a/b.txt to a, or a to a/b.txt): making room
    // for the target would remove the source, so it is a removal and a write
    const at = candidates.findIndex((removal) => !nested(removal.parts, write.parts));
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

  for (const write of writes) {
    if (write.moved) continue;
    await writeBlob(blogID, reader, write.parts, write.oid, stats);
  }

  log("Applied from the store: " + JSON.stringify(stats));

  return paths;
}

module.exports = materialize;
module.exports.SKIP_CHECK_BYTES = SKIP_CHECK_BYTES;
module.exports.EMPTY_TREE = EMPTY_TREE;
