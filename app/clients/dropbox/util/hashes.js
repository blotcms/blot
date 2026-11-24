const { RESP_TYPES } = require("redis");
const client = require("models/client");

// Dropbox's content_hash of the files in a blog's folder, so the hourly walk
// doesn't read every file to work it out (#2258, "Content hash"). It depends
// only on a file's bytes, so it is stored by the file's SHA-1, which the
// folder's index already has (storage/folder stat { sha1: true }): a rename
// or a copy costs nothing, and an edited file has a new SHA-1, so a stored
// hash is never stale.
//
// One Redis string per blog, read whole: fixed-width records of the first
// 12 bytes of the SHA-1 then the first 12 bytes of the content_hash, about
// 26 bytes a file in Redis. 96 bits each is far beyond a collision in one
// blog, and a wrong hash would only cost a download, or a missed one once in
// 2^96. Syncs only APPEND records, never reading the string; the walk, which
// lists every file anyway, reads it once and rewrites it with just the
// records it used, so records for deleted files drop out.

const PART = 12;
const RECORD = PART * 2;

const key = (blogID) => "blog:" + blogID + ":dropbox:hashes";

const part = (hex) => Buffer.from(hex.slice(0, PART * 2), "hex");

const valid = (sha1, contentHash) =>
  /^[0-9a-f]{40}$/.test(sha1 || "") && /^[0-9a-f]{64}$/.test(contentHash || "");

const encode = (pairs) =>
  Buffer.concat(
    pairs.map(([sha1, contentHash]) =>
      Buffer.concat([part(sha1), part(contentHash)])
    )
  );

// Records that a file with this SHA-1 has this content_hash. Best effort:
// a failure only costs hashing the file again.
async function add(blogID, sha1, contentHash) {
  if (!valid(sha1, contentHash)) return;
  try {
    await client.append(key(blogID), encode([[sha1, contentHash]]));
  } catch (err) {
    console.error("Dropbox: failed to store content hash", blogID, err);
  }
}

// For a walk: get(sha1) answers the stored content_hash prefix (24 hex
// characters) or undefined, set(sha1, contentHash) adds one, and save()
// writes back what get() and set() saw, dropping the rest.
async function load(blogID) {
  let stored = null;
  try {
    stored = await client
      .withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer })
      .get(key(blogID));
  } catch (err) {
    console.error("Dropbox: failed to load content hashes", blogID, err);
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

    set(sha1, contentHash) {
      if (!valid(sha1, contentHash)) return;
      const id = sha1.slice(0, PART * 2);
      const prefix = contentHash.slice(0, PART * 2);
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
        console.error("Dropbox: failed to save content hashes", blogID, err);
      }
    },
  };
}

// At disconnect
async function drop(blogID) {
  await client.del(key(blogID));
}

module.exports = { add, load, drop, key };
