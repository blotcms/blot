const { RESP_TYPES } = require("redis");
const client = require("models/client");

// A client's remote hash of the files in a blog's folder (Dropbox's
// content_hash, Google Drive's md5Checksum), so a walk comparing the folder
// with the remote one doesn't read every file to work it out (#2258,
// "Content hash"). It depends only on a file's bytes, so it is stored by the
// file's SHA-1, which the folder's index already has (storage/folder stat
// { sha1: true }): a rename or a copy costs nothing, and an edited file has a
// new SHA-1, so a stored hash is never stale.
//
// One Redis string per blog and client, read whole: fixed-width records of
// the first 12 bytes of the SHA-1 then the first 12 bytes of the remote hash,
// about 26 bytes a file in Redis. 96 bits each is far beyond a collision in
// one blog, and a wrong hash would only cost a download, or a missed one once
// in 2^96. Syncs only append records (add), never reading the string; a walk,
// which lists every file anyway, reads it once (load) and rewrites it with
// just the records it used, so records for deleted files drop out.
//
//   const hashes = require("clients/util/remoteHashes")("dropbox");
//
// A remote hash is hex or a Buffer, of at least 12 bytes. get() answers its
// first 12 bytes as 24 hex characters, which the caller compares with the
// start of the remote hash it has.

const PART = 12;
const RECORD = PART * 2;

const hex = (hash) => (Buffer.isBuffer(hash) ? hash.toString("hex") : hash);

const part = (hash) => Buffer.from(hex(hash).slice(0, PART * 2), "hex");

const valid = (sha1, remote) =>
  /^[0-9a-f]{40}$/.test(sha1 || "") &&
  /^[0-9a-f]{24,}$/i.test(hex(remote) || "");

const encode = (pairs) =>
  Buffer.concat(
    pairs.map(([sha1, remote]) => Buffer.concat([part(sha1), part(remote)]))
  );

// name is the client's, which keys its records: blog:{blogID}:{name}:hashes,
// so blog deletion's blog:{blogID}:* sweep removes them
module.exports = function remoteHashes(name) {
  const key = (blogID) => "blog:" + blogID + ":" + name + ":hashes";

  // Records that a file with this SHA-1 has this remote hash. Best effort:
  // a failure only costs hashing the file again.
  async function add(blogID, sha1, remote) {
    if (!valid(sha1, remote)) return;
    try {
      await client.append(key(blogID), encode([[sha1, remote]]));
    } catch (err) {
      console.error(name + ": failed to store a remote hash", blogID, err);
    }
  }

  // For a walk: get(sha1) answers the stored remote hash prefix (24 hex
  // characters) or undefined, set(sha1, remote) adds one, and save()
  // writes back what get() and set() saw, dropping the rest.
  async function load(blogID) {
    let stored = null;
    try {
      stored = await client
        .withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer })
        .get(key(blogID));
    } catch (err) {
      console.error(name + ": failed to load remote hashes", blogID, err);
    }

    const known = new Map();
    for (let i = 0; stored && i + RECORD <= stored.length; i += RECORD) {
      known.set(
        stored.toString("hex", i, i + PART),
        stored.toString("hex", i + PART, i + RECORD)
      );
    }

    const used = new Map();
    let added = false;

    return {
      get(sha1) {
        if (!sha1) return undefined;
        const id = sha1.slice(0, PART * 2);
        const prefix = known.get(id);
        if (prefix !== undefined) used.set(id, prefix);
        return prefix;
      },

      set(sha1, remote) {
        if (!valid(sha1, remote)) return;
        const id = sha1.slice(0, PART * 2);
        const prefix = hex(remote)
          .slice(0, PART * 2)
          .toLowerCase();
        known.set(id, prefix);
        used.set(id, prefix);
        added = true;
      },

      // complete: the walk saw every file, so only what it used is kept.
      // Otherwise the new records are added to what was there.
      async save({ complete }) {
        try {
          if (complete) {
            if (!added && used.size === known.size) return;
            const pairs = [...used];
            if (!pairs.length) await client.del(key(blogID));
            else await client.set(key(blogID), encode(pairs));
          } else if (added) {
            await client.set(key(blogID), encode([...known]));
          }
        } catch (err) {
          console.error(name + ": failed to save remote hashes", blogID, err);
        }
      },
    };
  }

  // When the blog leaves the client
  async function drop(blogID) {
    await client.del(key(blogID));
  }

  return { add, load, drop, key };
};
