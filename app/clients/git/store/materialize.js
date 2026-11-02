// Brings a folder from one commit to another by reading the repository's packs
// by range, with no checkout and no copy of the repository on disk. The trees
// of the two commits are diffed (treediff.js), and each changed file is
// streamed from the packs into a sink. Only the changed paths are touched.
//
//   const { written, removed, skipped } = await materialize({ reader, from, to, sink })
//
// `from` and `to` are commit IDs, or null for the empty tree (`from` is null
// for a folder with nothing applied yet; `to` is null to empty it).
//
// The sink is where the files go: a local folder (folderSink.js) or, later, a
// prefix in S3. Paths are relative, with "/" between names, and are always
// safe (see safeParts) by the time a sink sees them.
//
//   write(path, stream, { mode, size })
//     Makes `path` a file with the bytes of `stream` (a Readable, `size` bytes
//     of them), in place of whatever is there, a link or a directory included.
//     `mode` is 0o644 or 0o755. The stream throws at its end if the bytes are
//     not the blob they should be, so a sink must not publish the file until
//     the stream has ended without error. Directories above it are made.
//   remove(path)
//     Removes the file or link at `path`, and any directory which that leaves
//     empty. Nothing there is not an error. A directory is not removed.
//   symlink(path, target)
//     Makes `path` a symbolic link to `target`. Only called with `symlinks`.
//
// A sink may be called for several paths at once, up to `concurrency` writes
// (default 8). It is never asked to remove while a write is running, or to
// write while a removal is, so a path which changes kind is safe: the sink has
// finished with the old before it is asked for the new.
//
// Files are written as the raw committed bytes (their mode is 0644 or 0755),
// so .gitattributes rules such as eol and ident do not apply. Symbolic links
// are not written, because pushes no longer allow them, but one that was in the
// way or has been deleted is removed. Submodules are skipped. This is what the
// materializer on EBS (app/clients/git/materialize.js) does, so that the
// same commits give the same folder.
//
// Paths come from history which may predate the checks a push goes through now,
// so a path is only used if it is safe: no empty, "." or ".." component, no
// ".git" component in any case, and every name UTF-8. Nothing is then written
// outside the folder, and the folder's own .git directory is never touched.
//
// Blobs come through reader.stream, so one stored whole is never held in
// memory, and each is checked against its ID as it goes. One stored as a delta
// is resolved in memory, which `maxSize` (the reader's, unless given here)
// limits: a bigger one fails the whole call with a TooLargeError saying which
// path, and never gives the sink a wrong or partial file.
//
// A failure part way (a missing object, a sink error, a store error) leaves
// the sink part applied and is thrown once the writes in flight have ended. The
// caller runs the same range again. That is safe: a write replaces the file, a
// removal of what is gone does nothing, and so the second run ends where an
// uninterrupted one would. The last applied commit is the caller's to record,
// and only after this resolves.
const { Readable } = require("stream");
const { parseCommit } = require("./objects");
const { diffTrees } = require("./treediff");
const { CorruptError, NotFoundError, TooLargeError } = require("./errors");

const MODES = { "100644": 0o644, "100755": 0o755 };

const SYMLINK = "120000";

// A link's target is a path, so this is far more than one is
const MAX_TARGET_BYTES = 64 * 1024;

const DEFAULT_CONCURRENCY = 8;

// The names in a path, or null if it is not safe to use
function safeParts(file) {
  const parts = file.split("/");

  for (const part of parts) {
    if (!part || part === "." || part === "..") return null;
    if (part.toLowerCase() === ".git") return null;
  }

  return parts;
}

async function treeOf(reader, commit) {
  if (!commit) return null;

  const object = await reader.read(commit);
  if (!object) throw new NotFoundError("Commit " + commit + " is not in the repository");
  if (object.type !== "commit") throw new CorruptError("Object " + commit + " is a " + object.type + ", not a commit");

  return parseCommit(object.data).tree;
}

async function materialize({ reader, from = null, to = null, sink, concurrency = DEFAULT_CONCURRENCY, maxSize, symlinks = false, log = function () {} }) {
  const [a, b] = await Promise.all([treeOf(reader, from), treeOf(reader, to)]);
  const result = { written: 0, removed: 0, skipped: 0 };
  const limits = maxSize === undefined ? {} : { maxSize };
  const running = new Set();
  let kind = null;
  let failure = null;

  async function writeBlob(file, change) {
    let blob;

    try {
      blob = await reader.stream(change.newOid, limits);
    } catch (err) {
      if (err.code !== "TOO_LARGE") throw err;
      throw new TooLargeError(
        "Cannot write " + file + ": blob " + change.newOid + " is stored as a delta and is too large to resolve (" + err.message + ")"
      );
    }

    if (!blob) throw new NotFoundError("Blob " + change.newOid + " (" + file + ") is not in the repository");
    if (blob.type !== "blob") throw new CorruptError("Object " + change.newOid + " is a " + blob.type + ", not a blob");

    const body = Readable.from(blob.data, { objectMode: false });

    try {
      await sink.write(file, body, { mode: MODES[change.newMode], size: blob.size });
    } finally {
      body.destroy();
    }

    result.written++;
  }

  async function writeLink(file, change) {
    const blob = await reader.read(change.newOid, { maxSize: MAX_TARGET_BYTES });

    if (!blob) throw new NotFoundError("Blob " + change.newOid + " (" + file + ") is not in the repository");

    await sink.symlink(file, blob.data.toString("utf8"));
    result.written++;
  }

  async function removeFile(file) {
    await sink.remove(file);
    result.removed++;
  }

  // Waits until nothing is running
  async function drain() {
    await Promise.all(running);
  }

  // Starts a task of one kind ("write" or "remove") once there is a free slot
  // and nothing of the other kind is running
  async function start(next, task) {
    if (next !== kind) await drain();
    kind = next;

    while (running.size >= concurrency && !failure) await Promise.race(running);
    if (failure) return;

    const promise = task().then(
      function () {},
      function (err) {
        failure = failure || { err };
      }
    );

    running.add(promise);
    promise.then(() => running.delete(promise));
  }

  try {
    for await (const change of diffTrees({ reader, a, b, concurrency })) {
      if (failure) break;

      const parts = change.valid ? safeParts(change.path) : null;

      if (!parts) {
        log("Skipping a path that is not safe to write: " + JSON.stringify(change.path));
        result.skipped++;
      } else if (change.newMode in MODES) {
        await start("write", () => writeBlob(change.path, change));
      } else if (change.newMode === SYMLINK && symlinks) {
        await start("write", () => writeLink(change.path, change));
      } else if (change.oldMode in MODES || change.oldMode === SYMLINK) {
        // Gone, or something we do not write (a link or submodule) in its place
        await start("remove", () => removeFile(change.path));
      } else {
        result.skipped++;
      }
    }
  } catch (err) {
    failure = failure || { err };
  }

  await drain();

  if (failure) throw failure.err;

  return result;
}

module.exports = materialize;
module.exports.safeParts = safeParts;
