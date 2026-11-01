// One byte-capped LRU cache on local disk, shared by every repository.
//
// Nothing here is the source of truth and nothing is required to be here: an
// entry can be evicted, or deleted from under us, at any moment and a miss
// only costs round trips to the object store. So put() may decline to store
// something, get() treats anything it doesn't trust as a miss, and a cache with
// a cap of a few kilobytes is merely slow, never wrong.
//
// The cap covers everything the cache puts on disk, including the scratch
// space reserved for pushes (see reserve()), so the host sets one number for
// the whole git disk budget. Reservations are the one thing the cache cannot
// evict.
//
// Each entry is a file: a 16-byte header (magic, CRC-32 and length of the
// data), then the data. It is written to a temporary file and renamed into
// place, so a reader never sees a partial write; the header catches anything
// else (a disk error, a truncated file) and such an entry is deleted and
// reported as a miss.
//
// The recency list is in memory and rebuilt from the files' modification times
// when the cache is opened. One cache instance should own a directory: two
// processes sharing one would each count only their own writes against the cap.
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const { NoRoomError } = require("./errors");

const MAGIC = Buffer.from("BGC1");
const HEADER = 16;

const NAME = /^[0-9a-f]{64}$/;

let sequence = 0;

function nameFor(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function encode(data) {
  const header = Buffer.alloc(HEADER);
  MAGIC.copy(header);
  header.writeUInt32BE(zlib.crc32(data), 4);
  header.writeBigUInt64BE(BigInt(data.length), 8);
  return [header, data];
}

// The data in a cache file, or null if the file is not a complete, intact entry
function decode(file) {
  if (file.length < HEADER || !file.subarray(0, 4).equals(MAGIC)) return null;
  const length = file.readBigUInt64BE(8);
  if (BigInt(file.length - HEADER) !== length) return null;

  const data = file.subarray(HEADER);
  return zlib.crc32(data) === file.readUInt32BE(4) ? data : null;
}

function createCache({ dir, maxBytes }) {
  if (!dir || !(maxBytes > 0)) throw new Error("createCache needs a dir and a positive maxBytes");

  const entriesDir = path.join(dir, "entries");
  const tmpDir = path.join(dir, "tmp");
  const scratchDir = path.join(dir, "scratch");

  // name -> bytes on disk. Map order is recency: first is the least recent.
  const entries = new Map();
  let entryBytes = 0;
  let writingBytes = 0;
  let reservedBytes = 0;
  const counters = { hits: 0, misses: 0, evictions: 0, corrupt: 0 };

  const entryPath = (name) => path.join(entriesDir, name.slice(0, 2), name);
  const total = () => entryBytes + writingBytes + reservedBytes;

  async function unlink(file) {
    await fs.rm(file, { force: true });
  }

  function forget(name) {
    const size = entries.get(name);
    if (size === undefined) return;
    entries.delete(name);
    entryBytes -= size;
  }

  // Rebuilds the recency list from disk, and clears what an earlier process
  // left half done: temporary files and scratch space nobody holds any more
  async function scan() {
    await Promise.all([fs.rm(tmpDir, { recursive: true, force: true }), fs.rm(scratchDir, { recursive: true, force: true })]);
    await fs.mkdir(entriesDir, { recursive: true });

    const found = [];
    for (const shard of await fs.readdir(entriesDir)) {
      const shardDir = path.join(entriesDir, shard);
      for (const name of await fs.readdir(shardDir).catch(() => [])) {
        const file = path.join(shardDir, name);
        const stat = await fs.stat(file).catch(() => null);
        if (!stat || !NAME.test(name) || name.slice(0, 2) !== shard) await unlink(file);
        else found.push({ name, size: stat.size, time: stat.mtimeMs });
      }
    }

    found.sort((a, b) => a.time - b.time);
    for (const { name, size } of found) {
      entries.set(name, size);
      entryBytes += size;
    }
    await evict(0);
  }

  // Evicts least recently used entries until `needed` more bytes fit. Decides
  // synchronously, and the caller deletes the files of the entries returned,
  // so an entry is forgotten only if it is going to be deleted: if `needed`
  // can't fit even with every entry gone, nothing is evicted.
  function makeRoom(needed) {
    let short = total() + needed - maxBytes;
    const doomed = [];
    for (const [name, size] of entries) {
      if (short <= 0) break;
      doomed.push(name);
      short -= size;
    }
    if (short > 0) return { fits: false, doomed: [] };

    for (const name of doomed) {
      forget(name);
      counters.evictions++;
    }
    return { fits: true, doomed };
  }

  async function evict(needed) {
    const { fits, doomed } = makeRoom(needed);
    await Promise.all(doomed.map((name) => unlink(entryPath(name))));
    return fits;
  }

  // If the directory can't be used the cache is simply empty and stores
  // nothing; only reserve(), which needs the disk, reports why
  let openError = null;
  const ready = scan().then(
    () => true,
    (err) => {
      openError = err;
      return false;
    }
  );

  async function get(key) {
    if (!(await ready)) return null;
    const name = nameFor(key);

    if (!entries.has(name)) {
      counters.misses++;
      return null;
    }

    let data = null;
    try {
      data = decode(await fs.readFile(entryPath(name)));
      if (!data) counters.corrupt++;
    } catch (err) {
      if (err.code !== "ENOENT") counters.corrupt++;
    }

    if (!data) {
      forget(name);
      await unlink(entryPath(name));
      counters.misses++;
      return null;
    }

    // Move to the most recent end
    const size = entries.get(name);
    if (size !== undefined) {
      entries.delete(name);
      entries.set(name, size);
    }
    counters.hits++;
    return data;
  }

  // Stores data under key. Returns false if it was not stored (too big for
  // the cap, or the budget is held by reservations); callers carry on.
  async function put(key, data) {
    if (!(await ready)) return false;
    const name = nameFor(key);
    const size = HEADER + data.length;

    // Whatever the key held is stale now, whether or not this fits
    forget(name);
    const { fits, doomed } = size > maxBytes ? { fits: false, doomed: [] } : makeRoom(size);
    if (!fits) {
      await unlink(entryPath(name)).catch(() => {});
      return false;
    }
    writingBytes += size;

    const tmp = path.join(tmpDir, name + "." + process.pid + "." + ++sequence);
    try {
      // The file this key held goes too: its budget was released above, and
      // if the write below fails nothing else would ever delete it
      await Promise.all([name, ...doomed].map((old) => unlink(entryPath(old))));
      await fs.mkdir(tmpDir, { recursive: true });
      await fs.mkdir(path.dirname(entryPath(name)), { recursive: true });
      await fs.writeFile(tmp, Buffer.concat(encode(data)));
      await fs.rename(tmp, entryPath(name));
    } catch (err) {
      await unlink(tmp).catch(() => {});
      return false;
    } finally {
      writingBytes -= size;
    }

    forget(name);
    entries.set(name, size);
    entryBytes += size;
    return true;
  }

  async function remove(key) {
    if (!(await ready)) return;
    const name = nameFor(key);
    forget(name);
    await unlink(entryPath(name));
  }

  // Reserves `bytes` of the budget as scratch space for something which writes
  // files (a push), evicting cached data to make room. Throws NoRoomError if
  // the rest of the budget is already reserved. The reservation is a directory
  // the caller may fill up to that size; release() deletes it and gives the
  // bytes back, and must be called when the work ends, whether it worked or not.
  async function reserve(bytes) {
    if (!(await ready)) throw openError;
    claim(bytes);

    const reservation = {
      bytes,
      dir: path.join(scratchDir, String(++sequence) + "-" + crypto.randomBytes(4).toString("hex")),
      released: false,
    };

    try {
      await fs.mkdir(reservation.dir, { recursive: true });
    } catch (err) {
      reservedBytes -= bytes;
      throw err;
    }

    // Takes more of the budget for work which turned out bigger than expected
    reservation.extend = async function extend(more) {
      if (reservation.released) throw new Error("The reservation was released");
      claim(more);
      reservation.bytes += more;
    };

    reservation.release = async function release() {
      if (reservation.released) return;
      reservation.released = true;
      reservedBytes -= reservation.bytes;
      await fs.rm(reservation.dir, { recursive: true, force: true });
    };

    return reservation;
  }

  // Takes `bytes` for a reservation, evicting entries, or throws
  function claim(bytes) {
    if (!(bytes >= 0)) throw new Error("Cannot reserve " + bytes + " bytes");
    const { fits, doomed } = makeRoom(bytes);
    if (!fits) {
      throw new NoRoomError(
        "Not enough room for " + bytes + " bytes of scratch space: the cache holds " + maxBytes +
          " bytes and " + (reservedBytes + writingBytes) + " are in use by pushes and writes in flight"
      );
    }
    reservedBytes += bytes;
    // Fire and forget: the budget is already ours, and the files are only
    // disk usage which a failed delete leaves for the next scan
    for (const name of doomed) unlink(entryPath(name)).catch(() => {});
  }

  function stats() {
    return {
      maxBytes,
      entries: entries.size,
      entryBytes,
      reservedBytes,
      ...counters,
    };
  }

  // Throws everything away, which is always allowed
  async function clear() {
    if (!(await ready)) return;
    const names = [...entries.keys()];
    names.forEach(forget);
    await Promise.all(names.map((name) => unlink(entryPath(name))));
  }

  return { ready: () => ready, get, put, delete: remove, reserve, stats, clear, maxBytes };
}

module.exports = createCache;
