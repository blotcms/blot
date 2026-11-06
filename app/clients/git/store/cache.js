// One byte-capped cache on local disk, shared by every repository and by every
// process on the host which opens the same directory.
//
// Nothing here is the source of truth and nothing is required to be here: an
// entry can be evicted, or deleted from under us by another process, at any
// moment and a miss only costs round trips to the object store. So put() may
// decline to store something, get() and read() treat anything they don't
// trust as a miss, and a cache with a cap of a few kilobytes is merely slow,
// never wrong.
//
// The cap covers everything the cache puts on disk, including the scratch
// space reserved for pushes (see reserve()), so the host sets one number for
// the whole git disk budget. Reservations are the one thing the cache cannot
// evict.
//
// Entries. Each is a file named by the SHA-256 of its key: a 16-byte header
// (magic, block size, length of the data), a CRC-32 for each 64 KiB block of
// the data, then the data. It is written to a temporary file and renamed into
// place, so a reader never sees a partial write, and two processes writing the
// same key leave one whole entry. get() checks every block; read() (a range,
// for pack bytes) checks the blocks it reads. A damaged entry is deleted and
// is a miss. An entry deleted by another process while it is read is a miss
// if it was gone before it was opened, and is read whole if it was open (the
// file lives on until it is closed).
//
// Accounting across processes. No process holds a list of the entries: at
// 50 GB that would be millions of names in every process. Instead:
//
//   - recency is each file's modification time, set when it is written and
//     touched on a hit (at most once per touchEveryMs per entry and process);
//   - a walk of the directory measures the entries' bytes and a histogram of
//     their bytes by age, deletes the oldest when the cache is over its high
//     water mark (down to its low water mark) or the disk is short of free
//     space, and writes the totals to usage.json. Only one process walks at a
//     time (a lock file with a stale timeout, refreshed while it walks). It
//     runs in the background, a shard at a time with a few stats in flight,
//     so it never blocks the event loop and startup does not wait for it;
//   - between walks each process counts what it writes, and publishes that,
//     with its reservations and a heartbeat, in procs/<id>.json. Every process
//     reads the others' files (at most once a second, and always before a
//     reservation), so the estimate of the whole is the last walk's total plus
//     every process's writes since that walk began, plus every live process's
//     reservations. Deletions are not subtracted, so the estimate errs high
//     until the next walk.
//
// A put which would take the estimate past the cap is declined and asks for a
// walk; one past the high water mark asks for a walk and is stored.
//
// Free space. With minFreePercent, the cache also keeps that share of the
// filesystem it is on free (statfs): it declines puts which would go below
// it, a walk evicts what it takes to get back above it (and a point more),
// and a reservation which would go below it fails with NoRoomError.
//
// Scratch reservations count against the budget, and against every other
// process's reservations: a reservation is published first and then checked
// against the total of every live process's, and if that is over the cap it
// is withdrawn, so two processes reserving at once can both fail (and try
// again after a moment) but never both succeed past the cap. A process which
// dies leaves its file behind; once its heartbeat is older than staleMs its
// reservations stop counting, and its scratch and temporary directories are
// deleted.
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const { NoRoomError } = require("./errors");
const { mapLimit } = require("./limit");

const MAGIC = Buffer.from("BGC2");
const HEADER = 16;
const BLOCK = 64 * 1024;

const NAME = /^[0-9a-f]{64}$/;
const SHARD = /^[0-9a-f]{2}$/;
const ID = /^[0-9a-z]+-[0-9a-f]{8}$/;

const MINUTE = 60 * 1000;

const DEFAULTS = {
  // A walk is asked for past highWater of the cap, and evicts to lowWater
  highWater: 0.9,
  lowWater: 0.8,
  // How stale another process's counts may be for a put
  refreshMs: 1000,
  // How soon a process's counts are published after it writes
  publishDelayMs: 50,
  heartbeatMs: 30 * 1000,
  // A process whose heartbeat is older than this is gone
  staleMs: 10 * MINUTE,
  // A write this big or bigger (or a 64th of the cap, if less) is claimed
  // across processes before it starts, as a reservation is (see admit)
  claimWritesFrom: 1024 * 1024,
  // A walk at least this often, and no more often than walkGapMs unless asked
  walkEveryMs: 6 * 60 * MINUTE,
  walkGapMs: 30 * 1000,
  walkLockStaleMs: 2 * MINUTE,
  touchEveryMs: 10 * MINUTE,
  // The resolution of the histogram a walk evicts by
  bucketMs: 10 * MINUTE,
  statConcurrency: 16,
  // A walk for free space frees this many points more than the shortfall
  diskSlackPercent: 1,
};


const MAX_TOUCHED = 65536;

let sequence = 0;

function nameFor(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

const blocksOf = (length) => Math.ceil(length / BLOCK);
const entrySize = (length) => HEADER + 4 * blocksOf(length) + length;

function header(length) {
  const head = Buffer.alloc(HEADER);
  MAGIC.copy(head);
  head.writeUInt32BE(BLOCK, 4);
  head.writeBigUInt64BE(BigInt(length), 8);
  return head;
}

function encode(data) {
  const table = Buffer.alloc(4 * blocksOf(data.length));
  for (let b = 0; b * BLOCK < data.length; b++) table.writeUInt32BE(zlib.crc32(data.subarray(b * BLOCK, (b + 1) * BLOCK)), 4 * b);
  return Buffer.concat([header(data.length), table, data]);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createCache({ dir, maxBytes, minFreePercent = 0, statfs = (where) => fs.statfs(where), ...options }) {
  if (!dir || !(maxBytes > 0)) throw new Error("createCache needs a dir and a positive maxBytes");
  const o = { ...DEFAULTS, ...options };

  const id = Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
  const entriesDir = path.join(dir, "entries");
  const procsDir = path.join(dir, "procs");
  const locksDir = path.join(dir, "locks");
  const tmpRoot = path.join(dir, "tmp");
  const scratchRoot = path.join(dir, "scratch");
  // A process names its temporary files and scratch directories after itself
  const usageFile = path.join(dir, "usage.json");
  const ownFile = path.join(procsDir, id + ".json");

  const entryPath = (name) => path.join(entriesDir, name.slice(0, 2), name);
  const tmpPath = (name) => path.join(tmpRoot, id + "." + name + "." + ++sequence);

  const counters = { hits: 0, misses: 0, evictions: 0, corrupt: 0, walks: 0, declined: 0 };

  // This process: what it has reserved, what it is writing, every byte it has
  // ever written (a counter which only grows), and when it last touched each
  // entry
  let reservedBytes = 0;
  let writingBytes = 0;
  let addedTotal = 0;
  const touched = new Map();

  // The last walk, and the other processes, as last read. A walk records
  // each process's counter as it began (`base`), so what a process has
  // written since is its counter less that.
  let usage = { startedAt: 0, at: 0, entryBytes: 0, base: {} };
  let others = [];
  let refreshedAt = 0;

  let closed = false;
  const timers = [];

  // ---- What this process publishes ------------------------------------

  const sinceWalk = (who, total) => Math.max(0, total - ((usage.base && usage.base[who]) || 0));

  async function noteAdded(bytes) {
    addedTotal += bytes;
    // Near the cap the others should know at once
    if (estimate() > o.lowWater * maxBytes) await publishNow();
    else publishSoon();
  }

  async function writeJSON(file, value) {
    const tmp = tmpPath(path.basename(file));
    try {
      await fs.writeFile(tmp, JSON.stringify(value));
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  // Writes are one at a time, each with the counts as they are when it runs
  let publishing = Promise.resolve();
  let publishTimer = null;
  function publishNow() {
    if (closed) return publishing;
    if (publishTimer) {
      clearTimeout(publishTimer);
      publishTimer = null;
    }
    publishing = publishing.then(() =>
      writeJSON(ownFile, { id, pid: process.pid, beat: Date.now(), reserved: reservedBytes + writingBytes, added: addedTotal }).catch(() => {})
    );
    return publishing;
  }

  function publishSoon() {
    if (publishTimer || closed) return;
    publishTimer = setTimeout(publishNow, o.publishDelayMs);
    publishTimer.unref();
  }

  // ---- What the others publish ------------------------------------------

  async function readJSON(file) {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch (err) {
      return null;
    }
  }

  let refreshing = null;
  function refresh() {
    if (!refreshing) {
      refreshing = (async () => {
        const read = await readJSON(usageFile);
        if (read && Number.isFinite(read.startedAt) && Number.isFinite(read.entryBytes)) usage = { base: {}, ...read };

        const names = await fs.readdir(procsDir).catch(() => []);
        const found = [];
        await mapLimit(names, 16, async (file) => {
          const other = file.endsWith(".json") && file !== id + ".json" ? await readJSON(path.join(procsDir, file)) : null;
          if (other && ID.test(other.id) && file === other.id + ".json") found.push(other);
        });
        others = found;
        refreshedAt = Date.now();
      })().finally(() => (refreshing = null));
    }
    return refreshing;
  }

  const isLive = (other, now = Date.now()) => now - other.beat < o.staleMs;

  function othersReserved() {
    const now = Date.now();
    return others.reduce((sum, other) => sum + (isLive(other, now) ? other.reserved || 0 : 0), 0);
  }

  // What the entries hold: the last walk's measure and what every process
  // has written since it began (a write the walk measured too, or one a
  // process had not yet published when the walk read its counter, is counted
  // twice, never not at all), and what is held by reservations and writes in
  // flight
  function entryEstimate() {
    return usage.entryBytes + sinceWalk(id, addedTotal) + others.reduce((sum, other) => sum + sinceWalk(other.id, other.added || 0), 0);
  }
  const heldBytes = () => reservedBytes + writingBytes + othersReserved();
  const estimate = () => entryEstimate() + heldBytes();

  // ---- Free space ---------------------------------------------------------

  let disk = null;
  let diskReading = null;
  function readDisk(fresh = false) {
    if (!minFreePercent) return Promise.resolve(null);
    if (!fresh && disk && Date.now() - disk.at < o.refreshMs) return Promise.resolve(disk);
    if (!diskReading) {
      diskReading = Promise.resolve()
        .then(() => statfs(dir))
        .then((found) => {
          const total = Number(found.blocks) * Number(found.bsize);
          disk = { at: Date.now(), free: Number(found.bavail) * Number(found.bsize), total, floor: (total * minFreePercent) / 100 };
          return disk;
        })
        .catch(() => null)
        .finally(() => (diskReading = null));
    }
    return diskReading;
  }

  // ---- Opening ------------------------------------------------------------

  async function open() {
    await Promise.all([entriesDir, procsDir, locksDir, tmpRoot].map((d) => fs.mkdir(d, { recursive: true })));
    await refresh();
    await publishNow();

    const heartbeat = setInterval(publishNow, o.heartbeatMs);
    const due = setInterval(() => Date.now() - usage.at > o.walkEveryMs && requestWalk(), Math.max(1000, Math.floor(o.walkEveryMs / 6)));
    timers.push(heartbeat, due);
    timers.forEach((t) => t.unref());

    // A first walk if the last one is old (or there has never been one); in
    // the background, so opening never waits for the directory to be read
    if (Date.now() - usage.at > o.walkEveryMs) requestWalk();
  }

  // If the directory can't be used the cache is simply empty and stores
  // nothing; only reserve(), which needs the disk, reports why
  let openError = null;
  const ready = open().then(
    () => true,
    (err) => {
      openError = err;
      return false;
    }
  );

  // ---- Reading ------------------------------------------------------------

  // The entry file `name` opened: { handle, length, dataStart, file }, or null
  // if there is none or it is not whole (which is deleted)
  async function openEntry(name) {
    const file = entryPath(name);
    let handle;
    try {
      handle = await fs.open(file, "r");
    } catch (err) {
      if (err.code !== "ENOENT") counters.corrupt++;
      return null;
    }

    try {
      const head = Buffer.alloc(HEADER);
      const { bytesRead } = await handle.read(head, 0, HEADER, 0);
      const { size } = await handle.stat();
      if (bytesRead === HEADER && head.subarray(0, 4).equals(MAGIC) && head.readUInt32BE(4) === BLOCK) {
        const length = Number(head.readBigUInt64BE(8));
        if (Number.isSafeInteger(length) && size === entrySize(length)) return { handle, length, dataStart: HEADER + 4 * blocksOf(length), file };
      }
    } catch (err) {
      // a read error is damage too
    }
    await handle.close().catch(() => {});
    await damaged(file);
    return null;
  }

  async function damaged(file) {
    counters.corrupt++;
    await fs.rm(file, { force: true }).catch(() => {});
  }

  // Bytes [offset, offset + length) of an open entry, clipped to its end,
  // each block they span checked; null if one is damaged
  async function readBlocks(entry, offset, length) {
    const end = Math.min(entry.length, offset + length);
    if (!(offset >= 0) || offset >= end) return Buffer.alloc(0);

    const first = Math.floor(offset / BLOCK);
    const last = Math.floor((end - 1) / BLOCK);
    const from = first * BLOCK;
    const to = Math.min(entry.length, (last + 1) * BLOCK);

    const table = Buffer.alloc(4 * (last - first + 1));
    const data = Buffer.allocUnsafe(to - from);
    const [t, d] = await Promise.all([
      entry.handle.read(table, 0, table.length, HEADER + 4 * first),
      entry.handle.read(data, 0, data.length, entry.dataStart + from),
    ]);
    if (t.bytesRead !== table.length || d.bytesRead !== data.length) return null;

    for (let b = first; b <= last; b++) {
      const block = data.subarray((b - first) * BLOCK, Math.min(data.length, (b - first + 1) * BLOCK));
      if (zlib.crc32(block) !== table.readUInt32BE(4 * (b - first))) return null;
    }
    return data.subarray(offset - from, end - from);
  }

  function touch(name, file) {
    const now = Date.now();
    const last = touched.get(name);
    if (last !== undefined && now - last < o.touchEveryMs) return;
    touched.delete(name);
    touched.set(name, now);
    if (touched.size > MAX_TOUCHED) touched.delete(touched.keys().next().value);
    const seconds = now / 1000;
    fs.utimes(file, seconds, seconds).catch(() => {});
  }

  // `fn(entry)` on the open entry for `key`; null for a miss
  async function withEntry(key, fn) {
    if (!(await ready)) return null;
    const name = nameFor(key);
    const entry = await openEntry(name);
    if (!entry) {
      counters.misses++;
      return null;
    }

    let data;
    try {
      data = await fn(entry);
    } catch (err) {
      data = null;
    } finally {
      await entry.handle.close().catch(() => {});
    }

    if (data === undefined) return null;
    if (!data) {
      await damaged(entry.file);
      counters.misses++;
      return null;
    }
    counters.hits++;
    touch(name, entry.file);
    return data;
  }

  // The data under `key`, or null. With maxBytes, an entry bigger than that
  // is not read (and is not a miss of the cache's making: it stays).
  function get(key, { maxBytes: most = Infinity } = {}) {
    return withEntry(key, (entry) => (entry.length > most ? undefined : readBlocks(entry, 0, entry.length)));
  }

  // Bytes [offset, offset + length) of the data under `key` (short at its
  // end), or null
  function read(key, offset, length) {
    return withEntry(key, (entry) => readBlocks(entry, offset, length));
  }

  // The length of the data under `key`, or null. Reads only the header, and
  // counts as neither a hit nor a miss.
  async function size(key) {
    if (!(await ready)) return null;
    const entry = await openEntry(nameFor(key));
    if (!entry) return null;
    await entry.handle.close().catch(() => {});
    return entry.length;
  }

  // ---- Writing ------------------------------------------------------------

  // Takes `bytes` for a write in flight if the cap and the disk allow it.
  //
  // A large write (a pack written through, say) is claimed as a reservation
  // is (see claim): published first, then checked against every process's,
  // and withdrawn if the total is over, so concurrent writes in several
  // processes cannot each take the same room. A small one is checked against
  // the others' counts as last read (at most refreshMs old, and read again
  // when it is near the cap), and decided with no await after that read, so
  // concurrent writes in this process cannot both take the last of the room;
  // what small writes racing in other processes can overshoot by is a few of
  // them, which the high water mark leaves room for.
  async function admit(bytes) {
    if (bytes > maxBytes) return false;

    if (bytes >= Math.min(o.claimWritesFrom, Math.floor(maxBytes / 64))) {
      const taken = await take(bytes, "write");
      if (!taken.ok) {
        counters.declined++;
        requestWalk();
        return false;
      }
      if (estimate() > o.highWater * maxBytes) requestWalk();
      return true;
    }

    if (Date.now() - refreshedAt > o.refreshMs) {
      const near = estimate() + bytes > o.highWater * maxBytes;
      const fresh = refresh().catch(() => {});
      if (near) await fresh;
    }
    const space = await readDisk();

    if (estimate() + bytes > maxBytes || (space && space.free - heldBytes() - bytes < space.floor)) {
      counters.declined++;
      requestWalk();
      return false;
    }
    writingBytes += bytes;
    if (estimate() > o.highWater * maxBytes) requestWalk();
    return true;
  }

  // The end of a write admit() took room for: what was in flight is either a
  // written entry now (counted by noteAdded) or nothing
  async function finishWrite(bytes, written) {
    writingBytes -= bytes;
    if (written) await noteAdded(bytes);
    else publishSoon();
  }

  // Stores data under key. Returns false if it was not stored (too big for
  // the cap, the budget is held, or the disk is short); callers carry on.
  // Whatever the key held is gone either way.
  async function put(key, data) {
    if (!(await ready)) return false;
    const name = nameFor(key);
    const bytes = entrySize(data.length);

    if (!(await admit(bytes))) {
      await fs.rm(entryPath(name), { force: true }).catch(() => {});
      return false;
    }

    const tmp = tmpPath(name);
    try {
      await fs.mkdir(path.dirname(entryPath(name)), { recursive: true });
      await fs.writeFile(tmp, encode(data));
      await fs.rename(tmp, entryPath(name));
    } catch (err) {
      await Promise.all([tmp, entryPath(name)].map((file) => fs.rm(file, { force: true }).catch(() => {})));
      await finishWrite(bytes, false);
      return false;
    }

    await finishWrite(bytes, true);
    return true;
  }

  // Stores `length` bytes from `source` (an async iterable of Buffers, a
  // Readable say) under key, written as they come, so memory does not depend
  // on the size. False, as put(), if it was not stored, and if the source
  // gave more or fewer bytes or failed. A Readable source is destroyed if it
  // is not read to its end.
  async function putStream(key, source, length) {
    const give = () => source && typeof source.destroy === "function" && source.destroy();
    if (!(await ready) || !Number.isSafeInteger(length) || length < 0) {
      give();
      return false;
    }
    const name = nameFor(key);
    const bytes = entrySize(length);

    if (!(await admit(bytes))) {
      give();
      await fs.rm(entryPath(name), { force: true }).catch(() => {});
      return false;
    }

    const tmp = tmpPath(name);
    let handle = null;
    try {
      await fs.mkdir(path.dirname(entryPath(name)), { recursive: true });
      handle = await fs.open(tmp, "w");
      const table = Buffer.alloc(4 * blocksOf(length));
      const dataStart = HEADER + table.length;
      let written = 0;
      let crc = 0;

      for await (const raw of source) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (written + chunk.length > length) throw new Error("The source is longer than " + length + " bytes");
        for (let at = 0; at < chunk.length; ) {
          const position = written + at;
          const n = Math.min(BLOCK - (position % BLOCK), chunk.length - at);
          crc = zlib.crc32(chunk.subarray(at, at + n), crc);
          if ((position + n) % BLOCK === 0 || position + n === length) {
            table.writeUInt32BE(crc, 4 * Math.floor(position / BLOCK));
            crc = 0;
          }
          at += n;
        }
        await handle.write(chunk, 0, chunk.length, dataStart + written);
        written += chunk.length;
      }
      if (written !== length) throw new Error("The source gave " + written + " of " + length + " bytes");

      await handle.write(header(length), 0, HEADER, 0);
      if (table.length) await handle.write(table, 0, table.length, HEADER);
      await handle.close();
      handle = null;
      await fs.rename(tmp, entryPath(name));
    } catch (err) {
      give();
      if (handle) await handle.close().catch(() => {});
      await Promise.all([tmp, entryPath(name)].map((file) => fs.rm(file, { force: true }).catch(() => {})));
      await finishWrite(bytes, false);
      return false;
    }

    await finishWrite(bytes, true);
    return true;
  }

  async function remove(key) {
    if (!(await ready)) return;
    await fs.rm(entryPath(nameFor(key)), { force: true }).catch(() => {});
  }

  // ---- Reservations ---------------------------------------------------------

  // Reserves `bytes` of the budget as scratch space for something which writes
  // files (a push), and asks for a walk if cached data must make room. Throws
  // NoRoomError if the rest of the budget is already reserved, by this
  // process or any other, or if the disk would go below its floor. The
  // reservation is a directory the caller may fill up to that size;
  // release() deletes it and gives the bytes back, and must be called when the
  // work ends, whether it worked or not.
  async function reserve(bytes) {
    if (!(await ready)) throw openError;
    await claim(bytes);

    const reservation = {
      bytes,
      dir: path.join(scratchRoot, id + "." + ++sequence + "-" + crypto.randomBytes(4).toString("hex")),
      released: false,
    };

    try {
      await fs.mkdir(reservation.dir, { recursive: true });
    } catch (err) {
      reservedBytes -= bytes;
      publishSoon();
      throw err;
    }

    // Takes more of the budget for work which turned out bigger than expected
    reservation.extend = async function extend(more) {
      if (reservation.released) throw new Error("The reservation was released");
      await claim(more);
      reservation.bytes += more;
    };

    // Gives back part of the reservation, for work which needed the room for
    // a while and no longer does (the scratch files of a delta being expanded)
    reservation.shrink = function shrink(less) {
      if (reservation.released) return;
      if (!(less >= 0) || less > reservation.bytes) throw new Error("Cannot give back " + less + " of " + reservation.bytes + " bytes");
      reservedBytes -= less;
      reservation.bytes -= less;
      publishSoon();
    };

    reservation.release = async function release() {
      if (reservation.released) return;
      reservation.released = true;
      reservedBytes -= reservation.bytes;
      try {
        await fs.rm(reservation.dir, { recursive: true, force: true });
      } finally {
        await publishNow();
      }
    };

    return reservation;
  }

  // Takes `bytes` for a reservation, or throws. Published before it is checked
  // against the others, and withdrawn if the total is over, so of two
  // processes reserving at once neither can take room the other has taken;
  // both may fail, so a failure the others caused is tried again a couple of
  // times after a short random wait.
  async function claim(bytes) {
    if (!(bytes >= 0)) throw new Error("Cannot reserve " + bytes + " bytes");

    const taken = await take(bytes, "reserve");
    if (taken.ok) {
      if (estimate() > o.highWater * maxBytes) requestWalk();
      return;
    }
    if (taken.reason === "disk") {
      requestWalk();
      throw new NoRoomError(
        "Not enough room for " + bytes + " bytes of scratch space: the disk has " + Math.max(0, Math.floor(taken.space.free)) +
          " bytes free, " + taken.outstanding + " of them promised to work in flight, and keeps " + minFreePercent + "% of it free"
      );
    }
    throw new NoRoomError(
      "Not enough room for " + bytes + " bytes of scratch space: the cache holds " + maxBytes +
        " bytes and " + taken.outstanding + " are in use by pushes and writes in flight"
    );
  }

  // Takes `bytes` of the budget, for a reservation (`kind` "reserve") or a
  // write in flight ("write"), as every process on the host sees it: the
  // claim is published first, then checked against every live process's
  // reservations and writes in flight (and, for a write, the entries), and
  // withdrawn if the total is over the cap. So of several processes claiming
  // at once none can take room another has taken; all may fail, so a failure
  // the others caused is tried again a couple of times after a short random
  // wait.
  //
  // The disk must keep its floor free after every claim outstanding on the
  // host, this one included: room promised to a reservation or a write is
  // not on disk yet, so statfs still shows it free. A reservation whose work
  // has already written part of its room is counted in full, which errs on
  // the side of refusing.
  //
  // Resolves { ok } or { ok: false, reason: "budget" | "disk", outstanding,
  // space }; when ok, `bytes` stays added to reservedBytes or writingBytes.
  async function take(bytes, kind) {
    const add = (n) => (kind === "write" ? (writingBytes += n) : (reservedBytes += n));

    for (let attempt = 0; ; attempt++) {
      add(bytes);
      await publishNow();
      await refresh().catch(() => {});
      const outstanding = heldBytes();
      const total = kind === "write" ? estimate() : outstanding;
      const space = await readDisk(true);
      const diskShort = !!space && space.free - outstanding < space.floor;

      if (total <= maxBytes && !diskShort) return { ok: true };

      add(-bytes);
      publishSoon();
      const failed = { ok: false, reason: diskShort ? "disk" : "budget", outstanding: outstanding - bytes, space };

      // Would fit but for the others' claims, which may be withdrawn ones
      // racing this one
      const others = othersReserved();
      const fitsAlone = total - others <= maxBytes && (!space || space.free - (outstanding - others) >= space.floor);
      if (attempt < 2 && others > 0 && fitsAlone) {
        await sleep(5 + Math.random() * 45);
        continue;
      }
      return failed;
    }
  }

  // ---- Locks ----------------------------------------------------------------

  // A lock file in the cache's directory, for work only one process on the
  // host should do at a time: { refresh(), release() }, or null if another
  // process holds it. A lock not refreshed for staleMs is taken over. Two
  // processes taking over the same stale lock at the same moment can both
  // get it; what the cache uses it for is safe to do twice.
  async function lock(name, { staleMs = o.walkLockStaleMs } = {}) {
    if (!(await ready)) return null;
    const file = path.join(locksDir, name + ".lock");

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.writeFile(file, id, { flag: "wx" });
        let released = false;
        return {
          refresh: () => {
            const seconds = Date.now() / 1000;
            return released ? Promise.resolve() : fs.utimes(file, seconds, seconds).catch(() => {});
          },
          release: async () => {
            if (released) return;
            released = true;
            const owner = await fs.readFile(file, "utf8").catch(() => null);
            if (owner === id) await fs.rm(file, { force: true }).catch(() => {});
          },
        };
      } catch (err) {
        if (err.code !== "EEXIST") return null;
        const stat = await fs.stat(file).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs <= staleMs) return null;
        await fs.rm(file, { force: true }).catch(() => {});
      }
    }
    return null;
  }

  // A small JSON note in the cache's directory, for its users (when a host
  // last warmed the cache, say); null if there is none
  async function readNote(name) {
    if (!(await ready)) return null;
    return readJSON(path.join(dir, "note-" + name + ".json"));
  }

  async function writeNote(name, value) {
    if (!(await ready)) return;
    await writeJSON(path.join(dir, "note-" + name + ".json"), value).catch(() => {});
  }

  // ---- Walking --------------------------------------------------------------

  let walking = null;
  let lastRequest = 0;

  function requestWalk() {
    if (closed || walking || Date.now() - lastRequest < o.walkGapMs) return;
    lastRequest = Date.now();
    walk().catch(() => {});
  }

  // How much a walk should evict, given what the entries hold: down to the
  // low water mark once past the high one, and whatever brings the disk back
  // above its floor
  async function excessOf(entryBytes) {
    const held = heldBytes();
    let excess = entryBytes + held > o.highWater * maxBytes ? entryBytes + held - o.lowWater * maxBytes : 0;
    const space = await readDisk(true);
    if (space && space.free < space.floor) excess = Math.max(excess, space.floor - space.free + (space.total * o.diskSlackPercent) / 100);
    return Math.max(0, Math.ceil(excess));
  }

  // The oldest buckets of `histogram` which hold `excess` bytes: everything in
  // a bucket before `cutoff` goes, and up to `boundary` bytes of the cutoff
  // bucket
  function planCutoff(histogram, excess) {
    let sum = 0;
    for (const bucket of [...histogram.keys()].sort((a, b) => a - b)) {
      const bytes = histogram.get(bucket);
      if (sum + bytes >= excess) return { cutoff: bucket, boundary: excess - sum };
      sum += bytes;
    }
    return { cutoff: Infinity, boundary: 0 };
  }

  // One pass over the entries: deletes what `plan` says (never an entry
  // written or touched since the walk began, unless `all`) and anything that
  // is not an entry, and measures the rest
  async function pass(plan, startedAt, walkLock, all = false) {
    const histogram = new Map();
    let entryBytes = 0;
    let boundaryFreed = 0;
    let freed = 0;

    for (const shard of await fs.readdir(entriesDir).catch(() => [])) {
      if (closed) break;
      const shardDir = path.join(entriesDir, shard);
      if (!SHARD.test(shard)) {
        await fs.rm(shardDir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      walkLock.refresh();

      const names = await fs.readdir(shardDir).catch(() => []);
      await mapLimit(names, o.statConcurrency, async (name) => {
        const file = path.join(shardDir, name);
        const stat = await fs.lstat(file).catch(() => null);
        if (!stat) return;
        if (!NAME.test(name) || name.slice(0, 2) !== shard || !stat.isFile()) {
          await fs.rm(file, { recursive: true, force: true }).catch(() => {});
          return;
        }

        const bucket = Math.floor(stat.mtimeMs / o.bucketMs);
        const doomed =
          all ||
          (plan && stat.mtimeMs < startedAt && (bucket < plan.cutoff || (bucket === plan.cutoff && boundaryFreed < plan.boundary)));
        if (doomed) {
          if (bucket === (plan && plan.cutoff)) boundaryFreed += stat.size;
          await fs.unlink(file).then(
            () => {
              freed += stat.size;
              counters.evictions++;
            },
            () => {}
          );
          return;
        }
        entryBytes += stat.size;
        histogram.set(bucket, (histogram.get(bucket) || 0) + stat.size);
      });
    }
    return { entryBytes, histogram, freed };
  }

  // Measures the cache and evicts what it must, if no other process is doing
  // so. Resolves with { walked, entryBytes, freed }.
  function walk({ all = false } = {}) {
    if (walking) return walking;
    walking = (async () => {
      if (!(await ready)) return { walked: false };
      const held = await lock("walk", { staleMs: o.walkLockStaleMs });
      if (!held) return { walked: false };

      const beat = setInterval(held.refresh, Math.max(10, Math.floor(o.walkLockStaleMs / 4)));
      beat.unref();
      try {
        await publishNow();
        await refresh().catch(() => {});
        const began = Date.now();
        const startedAt = all ? Infinity : began;

        // Every process's counter as the walk begins: what they write from
        // here on is counted on top of what the walk measures
        const base = { [id]: addedTotal };
        for (const other of others) base[other.id] = other.added || 0;

        // The last walk's histogram can only say how old the oldest entries
        // were (whatever was written since is newer); one which does not hold
        // the excess is not used, and this walk measures first
        let histogram = usage.bucketMs === o.bucketMs && usage.histogram ? new Map(Object.entries(usage.histogram).map(([k, v]) => [Number(k), v])) : null;
        let fresh = false;
        let measured = null;
        let freed = 0;

        for (let round = 0; round < 3; round++) {
          const excess = all ? 0 : await excessOf(measured ? measured.entryBytes : entryEstimate());
          if (measured && excess <= 0) break;
          let plan = excess > 0 && histogram ? planCutoff(histogram, excess) : null;
          if (plan && plan.cutoff === Infinity && !fresh) plan = null;
          measured = await pass(plan, startedAt, held, all);
          histogram = measured.histogram;
          fresh = true;
          freed += measured.freed;
          if (all) break;
        }

        const now = Date.now();
        usage = { startedAt: began, at: now, entryBytes: measured.entryBytes, base, bucketMs: o.bucketMs, histogram: Object.fromEntries(histogram) };
        await writeJSON(usageFile, usage).catch(() => {});
        await publishNow();
        counters.walks++;

        await clearDeparted(began);
        return { walked: true, entryBytes: measured.entryBytes, freed };
      } finally {
        clearInterval(beat);
        await held.release();
      }
    })().finally(() => (walking = null));
    return walking;
  }

  // Deletes the files of processes which are gone: their scratch directories
  // and temporary files (named <process id>.<...>) at once, and their counts
  // once a walk which began after their last heartbeat has measured what
  // they wrote. One whose process left no file is gone once it is staleMs
  // old.
  async function clearDeparted(startedAt) {
    await refresh().catch(() => {});
    const now = Date.now();
    const known = new Map(others.map((other) => [other.id, other]));
    known.set(id, { beat: now });

    for (const root of [scratchRoot, tmpRoot]) {
      for (const name of await fs.readdir(root).catch(() => [])) {
        const other = known.get(name.split(".")[0]);
        if (other && isLive(other, now)) continue;
        if (!other) {
          const stat = await fs.stat(path.join(root, name)).catch(() => null);
          if (stat && now - stat.mtimeMs < o.staleMs) continue;
        }
        await fs.rm(path.join(root, name), { recursive: true, force: true }).catch(() => {});
      }
    }

    for (const other of others) {
      if (!isLive(other, now) && other.beat < startedAt) await fs.rm(path.join(procsDir, other.id + ".json"), { force: true }).catch(() => {});
    }
  }

  // ---- The rest -------------------------------------------------------------

  function stats() {
    return {
      maxBytes,
      entryBytes: entryEstimate(),
      reservedBytes,
      hostReservedBytes: reservedBytes + writingBytes + othersReserved(),
      processes: 1 + others.filter((other) => isLive(other)).length,
      lastWalk: usage.at || null,
      ...counters,
    };
  }

  // Publishes this process's counts, runs a walk (waiting for one already
  // running here) and reads the others again: for specs, and for a host which
  // wants the figures to be current
  async function settle() {
    if (!(await ready)) return { walked: false };
    await publishNow();
    if (walking) await walking;
    lastRequest = Date.now();
    const result = await walk();
    await refresh().catch(() => {});
    return result;
  }

  // Throws everything away, which is always allowed
  async function clear() {
    if (!(await ready)) return;
    if (walking) await walking.catch(() => {});
    await walk({ all: true });
  }

  // Stops this process's timers. Its counts stay published until a walk
  // finds it gone.
  async function close() {
    if (!closed && (await ready)) await publishNow();
    closed = true;
    timers.forEach(clearInterval);
    if (walking) await walking.catch(() => {});
  }

  return { ready: () => ready, get, read, size, put, putStream, delete: remove, reserve, lock, readNote, writeNote, walk, settle, stats, clear, close, maxBytes, minFreePercent, id };
}

module.exports = createCache;
module.exports.DEFAULTS = DEFAULTS;
module.exports.entrySize = entrySize;
