const storage = require("storage/folder");
const hashes = require("./hashes");

// The hash of a file in the blog's folder, in the form of Dropbox's
// content_hash, or undefined if it can't be read (it isn't there, or is a
// folder or a placeholder, whose bytes aren't the file's): either way it never
// matches Dropbox's. Hashing can mean reading the whole file, so:
//
//   size        Dropbox's size for the file, compared first, from the index:
//               files of different sizes can't have the same bytes
//   remoteHash  Dropbox's content_hash for the file. With known, the hash
//               stored for the file's SHA-1 (util/hashes.js) answers without
//               reading it: remoteHash itself when they agree, so the caller's
//               comparison matches, and the stored prefix when they don't
//   known       a walk's util/hashes.js load(), or an async function giving
//               one, to look up and record in. A hash worked out here is
//               set() on it, for the walk to save
//   append      also APPEND a hash worked out here (util/hashes.js add), for a
//               caller which never saves known
async function localContentHash(blogID, path, options = {}) {
  const { size, remoteHash, append } = options;

  try {
    const stat = await storage.stat(blogID, path);
    if (stat.isDirectory || stat.placeholder) return undefined;
    if (typeof size === "number" && stat.size !== size) return undefined;

    // From the index, unless it has no SHA-1 for the file
    const { sha1 } = await storage.stat(blogID, path, { sha1: true });
    const known =
      typeof options.known === "function"
        ? await options.known()
        : options.known;
    const prefix = known && known.get(sha1);

    if (prefix !== undefined) {
      return remoteHash && remoteHash.startsWith(prefix) ? remoteHash : prefix;
    }

    const { hash } = await storage.stat(blogID, path, { hash: true });
    if (known) known.set(sha1, hash);
    if (append) await hashes.add(blogID, sha1, hash);
    return hash;
  } catch (e) {
    return undefined;
  }
}

module.exports = localContentHash;
