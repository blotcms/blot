// Streams a clone: one pack, written straight to the client from the
// repository's packs in the object store, by ranged reads, with bounded memory
// and nothing on local disk.
//
// The pack is a header with the total object count, every pack's entries
// copied verbatim (never decompressed and recompressed), and a SHA-1 trailer
// computed as it goes. An object can sit in several packs (`index-pack
// --fix-thin` appends the bases a push's deltas used, which older packs may
// hold), and a pack holding an object twice is rejected by clients. So the
// indexes are merged first, to count the objects and find the duplicates, and
// every copy but the newest is skipped. Skipping changes the entries around it:
//
// - an OFS_DELTA names its base by distance, so one that sits after a skipped
//   entry, with its base before that entry, gets a shorter distance;
// - an OFS_DELTA whose base was itself a skipped copy becomes a REF_DELTA
//   naming the base by ID (the kept copy is elsewhere in the pack).
//
// A pack with no skipped entries is copied in large chunks. A pack with
// skipped entries is copied up to its first skipped entry and walked entry by
// entry from there: each entry is inflated, and the output thrown away, only to
// find where its zlib stream ends (the index gives where an entry starts, not
// where it ends; see the README). That is the one place a `.rev` file would
// replace the inflating: endOf() below is where an entry's end is found.
//
// Memory does not grow with the repository or the number of packs. The copy
// holds a few chunks (chunkSize, 4 MB, times COPY_AHEAD) for the pack being
// sent and for up to two small packs read ahead, and an entry is passed on in
// pieces however large it is. The index merge holds a slice of every pack's
// IDs, sized so that all together stay within MERGE_BUDGET (down to a floor of
// MIN_SLICE IDs a pack, so with thousands of packs it grows slowly). The only
// things which grow are the list of skipped entries (36 bytes each) and the
// notes of where an entry's header changed (16 bytes each).
//
// Anything which goes wrong stops the transfer without the trailer being sent,
// so no client can take what it got for a whole pack: a truncated read, a store
// error, a corrupt entry. If the client asked for side-band, it is told with an
// error packet first.
const crypto = require("crypto");
const { finished } = require("stream/promises");
const { once } = require("events");
const { idxKey, packKey } = require("./layout");
const { readRanges } = require("./ranges");
const { chooseWhole, loadWhole } = require("./idx");
const { mapLimit } = require("./limit");
const { parseHeader } = require("./pack");
const inflateStream = require("./inflate");
const pktline = require("./pktline");
const { negotiate, choosePacks } = require("./fetch");
const { CorruptError, ProtocolError, UnsupportedError, BusyError, ClientGoneError } = require("./errors");

const FANOUT = 8 + 256 * 4;
const PACK_HEADER = 12;
const TRAILER = 20;
const MAX_ENTRY_HEADER = 32;

const CHUNK_SIZE = 4 * 1024 * 1024;
const COPY_AHEAD = 4;
const PREFETCH_PACKS = 2;

// Packs this small are read ahead while the one before is being sent, so a
// repository of many small packs isn't read one round trip at a time
const SMALL_PACK = 8 * 1024 * 1024;

const MERGE_BUDGET = 8 * 1024 * 1024;
// How many whole indexes are fetched at once (each is one GET)
const INDEX_CONCURRENCY = 64;
const MIN_SLICE = 64;
const MAX_SLICE = 16384;

// Small pieces are gathered up to this size before they are written
const COALESCE = 64 * 1024;

const MAX_REQUEST = 1024 * 1024;

// After this long planning, a side-band client is told the clone is under way
const KEEPALIVE_AFTER = 5000;
const KEEPALIVE = Buffer.from("0005\x01", "latin1");
const PROGRESS = pktline.packet(Buffer.concat([Buffer.from([2]), Buffer.from("Preparing your repository...\n")]));

const SIDEBAND_MAX = { "side-band-64k": 65515, "side-band": 995 };

const CONTENT_TYPE = "application/x-git-upload-pack-result";

function stopped(run) {
  if (run.signal.aborted) throw new ClientGoneError("The client went away");
}

// Reads [from, to) of a key in order, with a few chunks in flight at once so
// a long latency doesn't leave the connection idle. The first reads start when
// this is called, not when the result is first iterated. A short read is an
// error. Nothing new is started once the transfer has been abandoned.
function chunks(run, key, from, to) {
  const inflight = [];
  let next = from;

  const start = () => {
    if (next >= to || run.signal.aborted) return;
    const offset = next;
    const length = Math.min(run.chunkSize, to - offset);
    next += length;
    const promise = run.store.read(key, offset, length).then((buffer) => {
      if (buffer.length !== length) throw new CorruptError(key + " is shorter than the manifest says (read " + buffer.length + " of " + length + " at " + offset + ")");
      return buffer;
    });
    promise.catch(() => {});
    inflight.push(promise);
  };
  while (inflight.length < COPY_AHEAD && next < to && !run.signal.aborted) start();

  return (async function* () {
    try {
      while (inflight.length) {
        const buffer = await inflight.shift();
        stopped(run);
        start();
        yield buffer;
      }
      stopped(run);
    } finally {
      // abandoned: let the reads in flight settle quietly
      for (const promise of inflight) promise.catch(() => {});
    }
  })();
}

// A pack offset from a 4-byte index value, which for a pack over 2 GB points
// into the table of 8-byte offsets after the offsets
async function resolveOffset(run, pack, raw, whole = null) {
  if (!(raw & 0x80000000)) return raw;
  const at = FANOUT + pack.objects * 28 + (raw & 0x7fffffff) * 8;
  const bytes = whole ? whole.subarray(at, Math.min(at + 8, whole.length - 40)) : await run.store.read(idxKey(pack.name), at, 8);
  if (bytes.length !== 8) throw new CorruptError(idxKey(pack.name) + " is truncated");
  const offset = Number(bytes.readBigUInt64BE(0));
  if (!Number.isSafeInteger(offset)) throw new CorruptError(idxKey(pack.name) + " has an offset out of range");
  return offset;
}

// Merges the packs' indexes (their IDs are sorted) to find the objects which
// are in more than one. Returns, for each pack, the entries to skip as
// { offsets: sorted pack offsets, oids: the 20-byte IDs in the same order }.
// Of an object's copies the newest pack's is kept, which is the one the reader
// reads too.
// Keeping one copy across packs is only safe while every pack is
// self-contained (see "Clone" in the README).
async function planSkips(run, packs) {
  const skips = packs.map(() => []);
  if (packs.length < 2) return skips.map(finishSkips);

  const slice = Math.max(MIN_SLICE, Math.min(MAX_SLICE, Math.floor((run.mergeBudget || MERGE_BUDGET) / (packs.length * 24))));
  const cursors = packs.map((pack, index) => ({ pack, index, next: 0, ids: null, offsets: null, at: 0, count: 0, done: false, whole: null }));

  // The indexes small enough to be read whole (idx.js) are, all at once: from
  // the cache, or with one GET each, which then goes in the cache for the
  // next clone, lookup or push. The rest are read a slice at a time, and so is
  // everything when there is no cache: a clone reads each index once, so
  // reading it whole only pays when it is kept.
  const whole = run.cache ? chooseWhole(packs, run.cache) : new Set();
  await mapLimit(
    cursors.filter((cursor) => whole.has(cursor.pack.name)),
    INDEX_CONCURRENCY,
    async (cursor) => {
      stopped(run);
      const key = idxKey(cursor.pack.name);
      cursor.whole = await loadWhole({ store: run.store, key, size: cursor.pack.idxSize, cache: run.cache, namespace: run.store.id });
      if (cursor.whole.readUInt32BE(FANOUT - 4) !== cursor.pack.objects) {
        throw new CorruptError(key + " does not hold the " + cursor.pack.objects + " objects the manifest says");
      }
    }
  );

  async function refill(cursor) {
    stopped(run);
    const { pack } = cursor;
    if (cursor.next >= pack.objects) {
      cursor.done = true;
      return;
    }
    if (cursor.whole) {
      // All of it at once: it is in memory already
      cursor.ids = cursor.whole.subarray(FANOUT, FANOUT + pack.objects * 20);
      cursor.offsets = cursor.whole.subarray(FANOUT + pack.objects * 24, FANOUT + pack.objects * 28);
      cursor.at = 0;
      cursor.count = pack.objects;
      cursor.next = pack.objects;
      return;
    }
    const count = Math.min(slice, pack.objects - cursor.next);
    const key = idxKey(pack.name);
    const ranges = [
      { offset: FANOUT + cursor.next * 20, length: count * 20 },
      { offset: FANOUT + pack.objects * 24 + cursor.next * 4, length: count * 4 },
    ];
    // The first time, the fanout too (it sits right before the IDs, so it is
    // part of the same read): its last entry is the index's own object count
    if (cursor.next === 0) ranges.push({ offset: 0, length: FANOUT });

    const [ids, offsets, fanout] = await readRanges(run.store, key, ranges);
    if (ids.length !== count * 20 || offsets.length !== count * 4) throw new CorruptError(key + " is truncated");
    if (fanout && (fanout.length !== FANOUT || fanout.readUInt32BE(FANOUT - 4) !== pack.objects)) {
      throw new CorruptError(key + " does not hold the " + pack.objects + " objects the manifest says");
    }

    cursor.ids = ids;
    cursor.offsets = offsets;
    cursor.at = 0;
    cursor.count = count;
    cursor.next += count;
  }

  await Promise.all(cursors.map(refill));

  // A binary heap of the cursors, smallest current ID first and, among equal
  // IDs, the newest pack first
  const heap = cursors.filter((cursor) => !cursor.done);
  const idOf = (cursor) => cursor.ids.subarray(cursor.at * 20, cursor.at * 20 + 20);
  const less = (a, b) => {
    const order = Buffer.compare(idOf(a), idOf(b));
    return order < 0 || (order === 0 && a.index > b.index);
  };
  function down(i) {
    for (;;) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = left + 1;
      if (left < heap.length && less(heap[left], heap[smallest])) smallest = left;
      if (right < heap.length && less(heap[right], heap[smallest])) smallest = right;
      if (smallest === i) return;
      [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
      i = smallest;
    }
  }
  for (let i = (heap.length >> 1) - 1; i >= 0; i--) down(i);

  let last = null;
  while (heap.length) {
    const cursor = heap[0];
    const id = idOf(cursor);

    if (last && last.equals(id)) {
      const offset = await resolveOffset(run, cursor.pack, cursor.offsets.readUInt32BE(cursor.at * 4), cursor.whole);
      skips[cursor.index].push({ offset, oid: Buffer.from(id) });
    } else {
      last = Buffer.from(id);
    }

    cursor.at++;
    if (cursor.at >= cursor.count) await refill(cursor);
    if (cursor.done) {
      heap[0] = heap[heap.length - 1];
      heap.pop();
    }
    if (heap.length) down(0);
  }

  return skips.map(finishSkips);
}

function finishSkips(list) {
  list.sort((a, b) => a.offset - b.offset);
  return { offsets: Float64Array.from(list, (skip) => skip.offset), oids: Buffer.concat(list.map((skip) => skip.oid)), count: list.length };
}

// The index of the first skip at or after `offset`
function lowerBound(offsets, offset) {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid] < offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

// What the pack will hold: for each pack the entries to skip, and the count of
// objects left
async function plan(run, packs) {
  const skips = await planSkips(run, packs);
  const skipped = skips.reduce((n, skip) => n + skip.count, 0);
  const total = packs.reduce((n, pack) => n + pack.objects, 0) - skipped;
  if (total > 0xffffffff) throw new UnsupportedError("A pack holds at most 4 billion objects");
  return { packs, skips, skipped, total };
}

// A queue of the bytes of one pack, in front of a source of chunks, which
// hands out exact byte counts
function byteQueue(source) {
  const queue = [];
  let queued = 0;
  let ended = false;

  return {
    get queued() {
      return queued;
    },
    // Reads until at least n bytes are queued (or the source ends)
    async fill(n) {
      while (queued < n && !ended) {
        const next = await source.next();
        if (next.done) ended = true;
        else if (next.value.length) {
          queue.push(next.value);
          queued += next.value.length;
        }
      }
      return queued >= n;
    },
    // The first n queued bytes as one Buffer, not removed
    peek(n) {
      if (queue[0].length < n) {
        let k = 0;
        let size = 0;
        while (size < n) size += queue[k++].length;
        queue.unshift(Buffer.concat(queue.splice(0, k)));
      }
      return queue[0].subarray(0, n);
    },
    // Removes the first n bytes, which must be queued
    drop(n) {
      queued -= n;
      while (n > 0) {
        if (queue[0].length <= n) n -= queue.shift().length;
        else {
          queue[0] = queue[0].subarray(n);
          n = 0;
        }
      }
    },
    // Removes and returns the first queued chunk, or the first `max` bytes of it
    shift(max = Infinity) {
      const first = queue[0];
      const piece = first.subarray(0, max);
      if (piece.length === first.length) queue.shift();
      else queue[0] = first.subarray(max);
      queued -= piece.length;
      return piece;
    },
    unshift(buffer) {
      queue.unshift(buffer);
      queued += buffer.length;
    },
    close() {
      return source.return();
    },
  };
}

// Where the entry after its header ends: inflates its zlib stream, passing the
// compressed bytes on (when `forward`) exactly as they are, and returns how
// many there were. The queue is only left with bytes after the entry.
//
// A `.rev` file would make this unnecessary: it lists the pack's offsets in
// order, so an entry ends where the next one starts. Replace the body of this
// function with a lookup then.
async function* endOf(queue, size, what, forward) {
  const outbox = [];
  let pending = null;
  let passed = 0;

  // zlib only asks for more once it has used all of the last piece, so the
  // piece before the one it is working on is wholly the entry's
  const input = (async function* () {
    for (;;) {
      if (pending) {
        if (forward) outbox.push(pending);
        passed += pending.length;
        pending = null;
      }
      if (!queue.queued && !(await queue.fill(1))) return;
      pending = queue.shift();
      yield pending;
    }
  })();

  const stream = inflateStream(input, size, what);
  for await (const ignored of stream.output) {
    while (outbox.length) yield outbox.shift();
  }

  const used = stream.consumed();
  if (pending) {
    const mine = used - passed;
    if (forward && mine > 0) outbox.push(pending.subarray(0, mine));
    if (mine < pending.length) queue.unshift(pending.subarray(Math.max(mine, 0)));
  }
  while (outbox.length) yield outbox.shift();

  return used;
}

// An entry header: the type and size, as git writes them
function encodeHeader(code, size) {
  const bytes = [];
  let byte = (code << 4) | (size % 16);
  size = Math.floor(size / 16);
  while (size > 0) {
    bytes.push(byte | 0x80);
    byte = size % 128;
    size = Math.floor(size / 128);
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

// The distance of an OFS_DELTA to its base, as git writes it
function encodeDistance(distance) {
  const bytes = [distance % 128];
  while ((distance = Math.floor(distance / 128))) {
    distance--;
    bytes.unshift(0x80 | (distance % 128));
  }
  return Buffer.from(bytes);
}

const OFS_DELTA = 6;
const REF_DELTA = 7;

// One pack's entries, to be added to the pack being sent. `source` yields
// the pack's bytes from offset 0 up to its trailer.
async function* sendPack(run, pack, skip, source, stats) {
  const end = pack.size - TRAILER;
  const queue = byteQueue(source);
  const what = pack.name;

  try {
    if (!(await queue.fill(PACK_HEADER))) throw new CorruptError(what + " is shorter than its header");
    const header = queue.peek(PACK_HEADER);
    if (header.toString("latin1", 0, 4) !== "PACK" || header.readUInt32BE(4) !== 2 || header.readUInt32BE(8) !== pack.objects) {
      throw new CorruptError(what + " is not a version 2 pack of the " + pack.objects + " objects the manifest says");
    }
    queue.drop(PACK_HEADER);

    // Up to the first skipped entry, everything is copied as it comes
    const first = skip.count ? skip.offsets[0] : end;
    if (skip.count && (first < PACK_HEADER || first >= end)) throw new CorruptError(what + " has no entry at offset " + first);
    let at = PACK_HEADER;
    while (at < first) {
      if (!(await queue.fill(1))) throw new CorruptError(what + " is cut short");
      const piece = queue.shift(first - at);
      at += piece.length;
      yield piece;
    }
    if (!skip.count) {
      await queue.fill(TRAILER + 1);
      if (queue.queued !== TRAILER) throw new CorruptError(what + " is not the " + pack.size + " bytes the manifest says");
      return;
    }

    // From there entry by entry. What is sent is shorter than what is stored
    // by `net` bytes so far: a skipped entry is all removed, and an entry whose
    // header is rewritten gains or loses a few bytes. An entry's place in the
    // output is its place in the pack less `net` at that point, so an OFS_DELTA
    // needs the distance to its base reduced by the net change between them.
    // Only entries which change the net are noted: where each is, and the net
    // before it.
    const changeAt = [];
    const netBefore = [];
    let net = 0;
    let next = 0;

    while (at < end) {
      await queue.fill(MAX_ENTRY_HEADER);
      if (!queue.queued) throw new CorruptError(what + " is cut short");
      const entry = parseHeader(queue.peek(Math.min(queue.queued, MAX_ENTRY_HEADER)), at);
      const skipping = next < skip.count && skip.offsets[next] === at;
      const original = Buffer.from(queue.peek(entry.length));
      queue.drop(entry.length);

      let sent = 0;
      if (!skipping) {
        let replacement = original;

        if (entry.baseOffset !== undefined) {
          const base = lowerBound(skip.offsets, entry.baseOffset);
          if (skip.offsets[base] === entry.baseOffset) {
            // the base is a copy which isn't being sent: name it by ID instead
            replacement = Buffer.concat([encodeHeader(REF_DELTA, entry.size), skip.oids.subarray(base * 20, base * 20 + 20)]);
            stats.toRef++;
          } else {
            const before = lowerBound(changeAt, entry.baseOffset);
            const netAtBase = before < changeAt.length ? netBefore[before] : net;
            if (net !== netAtBase) {
              replacement = Buffer.concat([encodeHeader(OFS_DELTA, entry.size), encodeDistance(at - entry.baseOffset - (net - netAtBase))]);
              stats.rewritten++;
            }
          }
        }

        sent = replacement.length;
        yield replacement;
      }

      const used = yield* endOf(queue, entry.size, what + " entry at " + at, !skipping);
      const length = entry.length + used;

      const change = skipping ? length : entry.length - sent;
      if (change !== 0) {
        changeAt.push(at);
        netBefore.push(net);
        net += change;
      }
      if (skipping) {
        next++;
        stats.skipped++;
      }
      at += length;
    }

    if (at !== end) throw new CorruptError(what + " has an entry running into its checksum");
    await queue.fill(TRAILER + 1);
    if (queue.queued !== TRAILER) throw new CorruptError(what + " is not the " + pack.size + " bytes the manifest says");
    if (next !== skip.count) throw new CorruptError(what + " has no entry where its index says");
  } finally {
    await queue.close();
  }
}

// The pack to send as an async iterable of Buffers, for a plan from plan().
// Nothing is sent after a failure: the iterable throws, and the trailer, the
// last bytes, has not been produced.
async function* packStream(run, thePlan, stats) {
  const hash = crypto.createHash("sha1");
  const header = Buffer.alloc(PACK_HEADER);
  header.write("PACK");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(thePlan.total, 8);

  const sources = new Map();
  const open = (p) => {
    if (!sources.has(p)) {
      const pack = thePlan.packs[p];
      // The trailer is read too: an entry's zlib stream can only be seen to end
      // by what follows it, and for the last entry that is the trailer
      sources.set(p, chunks(run, packKey(pack.name), 0, pack.size));
    }
    return sources.get(p);
  };

  async function* body() {
    yield header;
    for (let p = 0; p < thePlan.packs.length; p++) {
      const source = open(p);
      for (let q = p + 1; q <= p + PREFETCH_PACKS && q < thePlan.packs.length; q++) {
        if (thePlan.packs[q].size <= SMALL_PACK) open(q);
      }
      yield* sendPack(run, thePlan.packs[p], thePlan.skips[p], source, stats);
      sources.delete(p);
    }
  }

  // Small pieces are joined up, so a pack of many small entries isn't written
  // a few bytes at a time
  let gathered = [];
  let size = 0;
  try {
    for await (const piece of body()) {
      stopped(run);
      hash.update(piece);
      stats.bytes += piece.length;

      if (piece.length >= COALESCE) {
        if (size) yield Buffer.concat(gathered);
        gathered = [];
        size = 0;
        yield piece;
      } else {
        gathered.push(piece);
        size += piece.length;
        if (size >= COALESCE) {
          yield Buffer.concat(gathered);
          gathered = [];
          size = 0;
        }
      }
    }
    if (size) yield Buffer.concat(gathered);
    stopped(run);
    const trailer = hash.digest();
    stats.bytes += trailer.length;
    yield trailer;
  } finally {
    for (const source of sources.values()) source.return().catch(() => {});
  }
}

// A packet of the side-band for each `max` bytes of `buffer`, as one buffer
function frameSideband(buffer, max) {
  const count = Math.ceil(buffer.length / max);
  const out = Buffer.allocUnsafe(buffer.length + count * 5);
  let at = 0;
  for (let from = 0; from < buffer.length; from += max) {
    const length = Math.min(max, buffer.length - from);
    out.write((length + 5).toString(16).padStart(4, "0"), at, "latin1");
    out[at + 4] = 1;
    buffer.copy(out, at + 5, from, from + length);
    at += length + 5;
  }
  return out;
}

// Writes to `out`; resolves once it can take more. `gone` rejects when `out`
// closes.
async function write(out, buffer, gone) {
  if (out.destroyed || out.writableEnded) throw new ClientGoneError("The client went away");
  if (out.write(buffer)) return;
  await Promise.race([once(out, "drain"), gone]);
}

// Counts the clones in progress. `max` run at once and up to `maxWaiting` wait
// for a place; more than that is a BusyError, for the host to answer with 503
// and a Retry-After. Each clone holds a few tens of megabytes of buffers (see
// the top of this file) and the sockets' own, so the host sets max from the
// memory it can spare; the limiter is the host's to share between the
// repositories it serves.
function createLimiter({ max, maxWaiting = 0 }) {
  let active = 0;
  const waiting = [];

  return {
    stats: () => ({ active, waiting: waiting.length }),
    // Resolves to a function which gives the place up
    async acquire() {
      if (active < max) {
        active++;
      } else {
        if (waiting.length >= maxWaiting) throw new BusyError("Too many clones are running");
        await new Promise((resolve) => waiting.push(resolve));
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = waiting.shift();
        if (next) next();
        else active--;
      };
    },
  };
}

// Writes the clone of the repository `manifest` describes to `out`, a Writable
// (an HTTP response). With `sideband` (a capability name, "side-band-64k" or
// "side-band") the pack goes in that sideband, after `prelude` (bytes to send
// first, which serve() uses for the negotiation's answer); without, it is
// written raw. `packs` are the packs to send, the manifest's all of them unless
// a fetch has worked out that the client has the older ones (fetch.js): they
// are planned and streamed exactly as a clone's are.
//
// Resolves { objects, bytes, skipped, rewritten, toRef } once all of it has been
// written. On failure it rejects and the transfer has not been completed:
// nothing which failed reaches `out` as a whole pack. If the failure came
// before anything was written, nothing was, and the host can still answer with
// an error status; otherwise `out` has been ended (after an error packet, when
// there is a sideband to carry it) or destroyed. A client which went away is a
// ClientGoneError: reading stopped as soon as it was known.
async function clone({ store, cache = null, manifest, packs = manifest.packs, out, prelude, sideband = null, limiter = null, chunkSize = CHUNK_SIZE, mergeBudget, keepaliveAfter = KEEPALIVE_AFTER, progress = true }) {
  const controller = new AbortController();
  const run = { store, cache, signal: controller.signal, chunkSize, mergeBudget };
  const stats = { objects: 0, bytes: 0, skipped: 0, rewritten: 0, toRef: 0 };
  const release = limiter ? await limiter.acquire() : () => {};
  let started = false;
  let timer = null;

  // A client which left while it queued is not worth planning for
  if (out.destroyed) {
    release();
    throw new ClientGoneError("The client went away");
  }

  // Rejects if the client goes away; nothing waits on it unless a write does
  const gone = new Promise((resolve, reject) => {
    out.once("close", () => {
      controller.abort();
      reject(new ClientGoneError("The client went away"));
    });
  });
  gone.catch(() => {});
  const ignore = () => {};
  out.on("error", ignore);

  try {
    // Planning a big repository can take long enough for a proxy to give up on
    // a response which has said nothing. So after `keepaliveAfter` ms a
    // side-band client is sent the prelude, one line of progress (unless it
    // asked for none) and then an empty band 1 packet every so often, which
    // git ignores. From then on a failure can only be reported on band 3.
    let sentPrelude = false;
    if (sideband && keepaliveAfter > 0) {
      const beat = () => {
        if (!out.destroyed && !out.writableEnded) out.write(KEEPALIVE);
      };
      timer = setTimeout(() => {
        if (out.destroyed || out.writableEnded) return;
        sentPrelude = true;
        started = true;
        if (prelude) out.write(prelude);
        if (progress) out.write(PROGRESS);
        beat();
        timer = setInterval(beat, keepaliveAfter);
      }, keepaliveAfter);
    }

    let thePlan;
    try {
      thePlan = await plan(run, packs);
    } finally {
      clearTimeout(timer);
      clearInterval(timer);
    }
    stats.objects = thePlan.total;

    const max = sideband ? SIDEBAND_MAX[sideband] : 0;
    if (prelude && !sentPrelude) await write(out, prelude, gone);
    started = true;

    for await (const piece of packStream(run, thePlan, stats)) {
      await write(out, sideband ? frameSideband(piece, max) : piece, gone);
    }
    if (sideband) await write(out, pktline.FLUSH, gone);

    out.end();
    await finished(out);
    return { objects: thePlan.total, bytes: stats.bytes, skipped: stats.skipped, rewritten: stats.rewritten, toRef: stats.toRef };
  } catch (caught) {
    // Whatever it looks like, a failure after the client left is that
    const err = controller.signal.aborted ? new ClientGoneError("The client went away") : caught;
    if (started && !out.destroyed) {
      if (sideband && !(err instanceof ClientGoneError)) {
        // git prints this and fails; it has not been sent a trailer
        out.end(pktline.packet(Buffer.concat([Buffer.from([3]), Buffer.from("The server failed while sending the repository.\n")])));
      } else {
        out.destroy();
      }
    }
    throw err;
  } finally {
    controller.abort();
    out.off("error", ignore);
    release();
  }
}

// What a POST to git-upload-pack asks for: { wants, haves, capabilities, done }.
// Throws UnsupportedError for what this store does not do, ProtocolError for
// what is not git.
function parseRequest(body) {
  if (body.length > MAX_REQUEST) throw new ProtocolError("The request is too large");

  const request = { wants: [], haves: [], capabilities: [], done: false };

  for (const packet of pktline.split(body)) {
    if (packet.flush) continue;

    const line = packet.data.toString("latin1");
    if (/^(shallow|deepen[-a-z]*|filter)( |$)/.test(line)) {
      throw new UnsupportedError("Shallow clones and filters are not supported");
    } else if (line.startsWith("want ")) {
      const oid = line.slice(5, 45);
      if (!/^[0-9a-f]{40}$/.test(oid) || (line.length > 45 && line[45] !== " ")) throw new ProtocolError("Bad want line");
      request.wants.push(oid);
      if (!request.capabilities.length) request.capabilities = line.slice(46).split(" ").filter(Boolean);
    } else if (line.startsWith("have ")) {
      const oid = line.slice(5);
      if (!/^[0-9a-f]{40}$/.test(oid)) throw new ProtocolError("Bad have line");
      request.haves.push(oid);
    } else if (line === "done") {
      request.done = true;
    } else {
      throw new ProtocolError("Unknown line in the request");
    }
  }

  return request;
}

// Every ID a client may ask for: the tips of the refs now and as they were
// after the recent pushes (the client read its refs a moment ago, and a push
// may have come between)
function tips(manifest) {
  const found = new Set(Object.values(manifest.refs));
  for (const snapshot of manifest.snapshots) for (const oid of Object.values(snapshot.refs)) found.add(oid);
  return found;
}

// What upload-pack says before the pack, in git's own words (see
// get_common_commits in upload-pack.c). A client which asked for
// multi_ack_detailed is told each common commit and, when a round has ended in
// a flush, whether the server is ready. A client which did not is only ever
// sent NAK, so it keeps negotiating until it says done. `early` is a round
// which ends with the pack, for a client which sent no-done: the final ACK
// follows NAK, as in git.
function acknowledgement({ commons, ready, done, early, detailed }) {
  const last = commons[commons.length - 1];
  const lines = detailed ? commons.map((oid) => "ACK " + oid + " common\n") : [];

  if (done) {
    lines.push(detailed && commons.length ? "ACK " + last + "\n" : "NAK\n");
  } else {
    if (detailed && ready && last) lines.push("ACK " + last + " ready\n");
    lines.push("NAK\n");
    if (early && last) lines.push("ACK " + last + "\n");
  }
  return Buffer.concat(lines.map((line) => pktline.packet(line)));
}

// Answers a POST to git-upload-pack. `body` is the request, already
// decompressed. Everything goes to `out`, which this ends.
//
// - A request which asks for nothing (git's "0000" probe) gets an empty answer.
// - A request for something this store does not do (shallow, filter, a client
//   without ofs-delta) or for an ID which is not a ref's tip gets an "ERR"
//   packet, which git shows as "remote error". Nothing else is sent.
// - A request which has not said done gets the answer to its have lines (see
//   fetch.js and acknowledgement above): which are common, and whether the
//   server is ready. With no-done and ready, the pack follows at once.
// - Otherwise: the acknowledgement, then one pack. For a request with no haves
//   that is the whole repository, as a clone. With haves it is the packs newer
//   than the newest snapshot of the refs which the client provably has, or all
//   of them if there is none. It is never too little and can be more than the
//   client needs.
//
// A ProtocolError (the request isn't git) is thrown before anything is written,
// so the host can answer 400. A BusyError is too (503), and so is a failure
// to read the history to negotiate. `cache` (cache.js) is optional and only
// saves requests.
async function serve({ store, cache, manifest, body, out, limiter, chunkSize, mergeBudget, keepaliveAfter, walkLimit, historyLimit }) {
  const request = parseRequestOrRefuse(body);
  const refusal = request.refusal || check(manifest, request);

  if (refusal) {
    out.end(pktline.packet("ERR " + refusal + "\n"));
    return { refused: refusal };
  }
  if (!request.wants.length) {
    out.end();
    return { empty: true };
  }

  const capabilities = request.capabilities;
  const detailed = capabilities.includes("multi_ack_detailed");
  const negotiation = request.haves.length
    ? await negotiate({ store, cache, manifest, haves: request.haves, limiter, maxWalk: walkLimit, maxHistory: historyLimit })
    : { floor: 0, commons: [], ready: false, walked: 0 };
  const facts = { commons: negotiation.commons.length, ready: negotiation.ready, walked: negotiation.walked };

  const early = !request.done && detailed && negotiation.ready && negotiation.commons.length > 0 && capabilities.includes("no-done");
  if (!request.done && !early) {
    out.end(acknowledgement({ ...negotiation, detailed }));
    return { negotiated: true, floor: negotiation.floor, ...facts };
  }

  const { packs, floor } = await choosePacks({ store, cache, manifest, wants: request.wants, negotiation });
  const sideband = capabilities.includes("side-band-64k") ? "side-band-64k" : capabilities.includes("side-band") ? "side-band" : null;
  const sent = await clone({
    store,
    cache,
    manifest,
    packs,
    out,
    prelude: acknowledgement({ ...negotiation, done: request.done, early, detailed }),
    sideband,
    limiter,
    chunkSize,
    mergeBudget,
    keepaliveAfter,
    progress: !capabilities.includes("no-progress"),
  });
  return { ...sent, floor, packs: packs.length, ...facts };
}

function parseRequestOrRefuse(body) {
  try {
    return parseRequest(body);
  } catch (err) {
    if (err instanceof UnsupportedError) return { refusal: err.message };
    throw err;
  }
}

function check(manifest, request) {
  if (request.wants.length && !request.capabilities.includes("ofs-delta")) return "This server needs a client which supports ofs-delta";
  if (request.capabilities.some((c) => c.startsWith("object-format=") && c !== "object-format=sha1")) return "Only sha1 repositories are supported";

  const allowed = tips(manifest);
  for (const oid of request.wants) if (!allowed.has(oid)) return "upload-pack: not our ref " + oid;
  return null;
}

module.exports = { clone, serve, parseRequest, createLimiter, plan, CONTENT_TYPE };
