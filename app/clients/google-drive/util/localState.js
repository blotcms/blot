const folder = require("storage/folder");
const { sameFingerprint } = require("./contentFingerprint");
const localFingerprint = require("./localFingerprint");

// What the client's records say about the file Blot holds at a path, so a
// later sync can tell whether that file has changed since without reading
// it. Kept in the client's own database (database/folder.js), beside the
// Drive md5Checksum of a verified file or the Drive modifiedTime of an
// applied one (#2258, "Content hash"):
//
//   size, modified  the file's size and modified time as storage/folder
//                   reports them, with modified rounded to the millisecond
//                   as models/file stores it. Both backends report the same
//                   values for the same file, since the mirror and the copy
//                   to disk keep a file's modified time, so a blog moving
//                   between the disk and S3 keeps matching.
//   sha1            the SHA-1 of the file's bytes, when known: free from
//                   the index on S3, a read of the file on disk. It is only
//                   asked for when size and modified no longer match, to
//                   tell a file rewritten with the same bytes from a changed
//                   one.
//
// A record written before these fields has fingerprint instead, the size and
// nanosecond mtime of the file on disk (util/contentFingerprint.js). It still
// counts while the disk agrees, and is replaced by size and modified the
// first time it matches. Drop that branch, and util/localFingerprint.js, once
// every Drive blog has synced since.

// { size, modified } of a file entry from storage/folder's list or stat, or
// null for a directory or anything without them
const stamp = (entry) => {
  if (!entry || entry.isDirectory) return null;
  if (!Number.isFinite(entry.size) || !Number.isFinite(entry.modified)) return null;
  return { size: entry.size, modified: Math.round(entry.modified) };
};

// The size in an old fingerprint: "size:mtimeNs", or the five-field
// "dev:ino:size:mtimeNs:ctimeNs"
const legacySize = (fingerprint) => {
  const parts = String(fingerprint).split(":");
  return Number(parts.length === 5 ? parts[2] : parts[0]);
};

const hasStamp = (record) =>
  Number.isFinite(record.size) && Number.isFinite(record.modified);

// Resolves to null if the file at path (entry is its listing) may have
// changed since record was written. Otherwise to { size, modified, sha1 }, the
// record's fields as they are now, and stale, true when those differ from
// what the record holds, so the caller stores them. Never rejects: a file it
// can't check counts as changed, which costs the caller's fallback
// comparison, never a missed change.
const unchanged = async (blogID, path, record, entry) => {
  const current = stamp(entry);

  if (!record || !current) return null;

  try {
    if (hasStamp(record)) {
      if (record.size !== current.size) return null;

      if (record.modified === current.modified) {
        return { size: current.size, modified: current.modified, sha1: record.sha1 || null, stale: false };
      }

      if (!record.sha1) return null;

      const { sha1 } = await folder.stat(blogID, path, { sha1: true });

      return sha1 === record.sha1 ? { ...current, sha1, stale: true } : null;
    }

    // A stat of the file on disk, or on S3 a download into the content
    // cache which can never match (the cached copy's mtime is new), so skip
    // it when the size alone rules the record out
    if (
      record.fingerprint &&
      legacySize(record.fingerprint) === current.size &&
      sameFingerprint(record.fingerprint, await localFingerprint(blogID, path))
    ) {
      return { ...current, sha1: null, stale: true };
    }
  } catch (err) {
    console.error("Google Drive: could not check", path, "against its record:", err.message);
  }

  return null;
};

// { size, modified, sha1 } of the file now at path, for a fresh record, or
// {} if it can't be read. On disk this reads the file to hash it.
const stateOf = async (blogID, path) => {
  try {
    const stat = await folder.stat(blogID, path, { sha1: true });
    const current = stamp(stat);
    return current ? { ...current, sha1: stat.sha1 || null } : {};
  } catch (err) {
    return {};
  }
};

module.exports = { stamp, unchanged, stateOf };
