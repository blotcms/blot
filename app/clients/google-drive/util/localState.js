const folder = require("storage/folder");

// The SHA-1 of the file Blot holds at a path, which is all a record needs to
// tell whether the file has changed since Blot wrote it. The folder's index
// has it for free (localReaddir passes it on, storage/folder stat gives it);
// only a file the index has no hash for is read to hash it.
//
// It used to be the file's size and modified time, with the SHA-1 only asked
// for when they disagreed: on disk a SHA-1 meant reading the whole file. With
// the index holding every file's SHA-1, comparing it is both cheaper and
// exact, and a file rewritten with the same bytes still matches.
//
// Records keep only { sha1 } of the local file now: the applied record of a
// Google Doc or another file Drive gives no md5Checksum for
// (database/folder.js setApplied). Files with an md5Checksum are matched by
// content instead (clients/util/remoteHashes.js).

// The SHA-1 of the file at path, entry being its listing (from localReaddir)
// if the caller has it. Null for a directory or a file that can't be read.
const sha1Of = async (blogID, path, entry) => {
  if (entry && entry.isDirectory) return null;
  if (entry && entry.sha1) return entry.sha1;
  try {
    const stat = await folder.stat(blogID, path, { sha1: true });
    return (stat && !stat.isDirectory && stat.sha1) || null;
  } catch (err) {
    return null;
  }
};

// Whether the file at path (entry is its listing) still holds the bytes
// record describes. Never rejects: a file it can't check counts as changed,
// which costs the caller's fallback comparison, never a missed change.
const unchanged = async (blogID, path, record, entry) => {
  if (!record || !record.sha1 || !entry || entry.isDirectory) return false;
  return (await sha1Of(blogID, path, entry)) === record.sha1;
};

// { sha1 } of the file now at path, for a fresh record, or {} if it can't be
// read
const stateOf = async (blogID, path, entry) => {
  const sha1 = await sha1Of(blogID, path, entry);
  return sha1 ? { sha1 } : {};
};

module.exports = { sha1Of, unchanged, stateOf };
