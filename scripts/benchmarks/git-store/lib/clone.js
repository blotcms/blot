// Streams one pack for a clone or fetch out of a repository's packs, by ranged
// reads, with bounded memory.
//
// The packs to send are written back to back as one pack: a header carrying
// the total object count, every pack's entries copied verbatim (no
// decompression, no recompression), and a SHA-1 trailer computed as it goes.
//
// An object can be in several packs (index-pack --fix-thin appends the bases a
// push's deltas used, which older packs already hold), and a pack in which an
// object appears twice is rejected by clients. So the indexes are compared
// first, by a merge of their sorted object IDs read in chunks, and the later
// copies are skipped. An OFS_DELTA whose base was a skipped copy becomes a
// REF_DELTA, and the offset of every other OFS_DELTA after a skipped entry is
// rewritten.
//
// Memory: the merge holds a chunk per pack; a pack with no skipped entries is
// copied in chunks; a pack with skipped entries is walked entry by entry and
// holds its entries' offsets (8 bytes each) and the largest entry it holds.
const crypto = require("crypto");
const { idxKey, packKey } = require("../../../../app/clients/git/store").layout;
const { readRanges } = require("../../../../app/clients/git/store");

const FANOUT = 8 + 256 * 4;
const COPY_CHUNK = 8 * 1024 * 1024;
const COPY_AHEAD = 4;
const MERGE_CHUNK = 16384;
const PREFETCH_PACKS = 2;
const SMALL_PACK = 16 * 1024 * 1024;

// Reads [from, to) of a key in order, with a few chunks in flight at once so
// a long latency doesn't leave the connection idle. The first reads start
// when this is called, not when the result is first iterated, so a caller can
// start the next pack while it is still sending this one. A short read is an
// error.
function chunks(store, key, from, to, { size = COPY_CHUNK, ahead = COPY_AHEAD } = {}) {
  const windows = [];
  for (let at = from; at < to; at += size) windows.push([at, Math.min(size, to - at)]);

  const inflight = [];
  let next = 0;
  const start = () => {
    const [offset, length] = windows[next++];
    const promise = store.read(key, offset, length).then((buffer) => {
      if (buffer.length !== length) throw new Error("Short read of " + key + " at " + offset + ": " + buffer.length + " of " + length);
      return buffer;
    });
    promise.catch(() => {});
    inflight.push(promise);
  };
  while (next < windows.length && inflight.length < ahead) start();

  return (async function* () {
    try {
      while (inflight.length) {
        const buffer = await inflight.shift();
        if (next < windows.length) start();
        yield buffer;
      }
    } finally {
      // abandoned: let the reads in flight settle quietly
      for (const promise of inflight) promise.catch(() => {});
    }
  })();
}

// An entry's offsets from the index, as the 4-byte values (large offsets are
// not supported: no pack here is over 2 GB)
async function readOffsets(store, pack) {
  const n = pack.objects;
  const start = FANOUT + n * 24;
  const all = new Float64Array(n);
  let at = 0;
  for await (const buffer of chunks(store, idxKey(pack.name), start, start + n * 4, { size: 4 * 1024 * 1024 })) {
    for (let i = 0; i + 4 <= buffer.length; i += 4) {
      const raw = buffer.readUInt32BE(i);
      if (raw & 0x80000000) throw new Error("Packs over 2 GB are not supported by this harness");
      all[at++] = raw;
    }
  }
  return all;
}

// Finds the objects to skip. `send` are manifest pack entries, oldest first.
// Returns, for each pack, a Map of offset -> object ID of the entries to skip
// (the copy in the oldest pack is the one kept).
async function planDedupe(store, send) {
  const cursors = send.map((pack, index) => ({ pack, index, next: 0, ids: null, offsets: null, at: 0, count: 0, done: false }));
  const skip = send.map(() => new Map());

  async function refill(cursor) {
    const { pack } = cursor;
    if (cursor.next >= pack.objects) {
      cursor.done = true;
      return;
    }
    const count = Math.min(MERGE_CHUNK, pack.objects - cursor.next);
    const [ids, offsets] = await readRanges(store, idxKey(pack.name), [
      { offset: FANOUT + cursor.next * 20, length: count * 20 },
      { offset: FANOUT + pack.objects * 20 + pack.objects * 4 + cursor.next * 4, length: count * 4 },
    ]);
    if (ids.length !== count * 20 || offsets.length !== count * 4) throw new Error("Short read of " + idxKey(pack.name));
    cursor.ids = ids;
    cursor.offsets = offsets;
    cursor.at = 0;
    cursor.count = count;
    cursor.next += count;
  }

  await Promise.all(cursors.map(refill));

  // A binary heap of the cursors, smallest current ID first (older pack first
  // among equals)
  const heap = cursors.filter((c) => !c.done);
  const idOf = (c) => c.ids.subarray(c.at * 20, c.at * 20 + 20);
  const less = (a, b) => {
    const order = Buffer.compare(idOf(a), idOf(b));
    return order < 0 || (order === 0 && a.index < b.index);
  };
  function down(i) {
    for (;;) {
      let m = i;
      const l = 2 * i + 1;
      const r = l + 1;
      if (l < heap.length && less(heap[l], heap[m])) m = l;
      if (r < heap.length && less(heap[r], heap[m])) m = r;
      if (m === i) return;
      [heap[i], heap[m]] = [heap[m], heap[i]];
      i = m;
    }
  }
  for (let i = (heap.length >> 1) - 1; i >= 0; i--) down(i);

  let last = null;
  while (heap.length) {
    const cursor = heap[0];
    const id = Buffer.from(idOf(cursor));
    if (last && last.equals(id)) {
      const raw = cursor.offsets.readUInt32BE(cursor.at * 4);
      if (raw & 0x80000000) throw new Error("Packs over 2 GB are not supported by this harness");
      skip[cursor.index].set(raw, id.toString("hex"));
    }
    last = id;

    cursor.at++;
    if (cursor.at >= cursor.count) await refill(cursor);
    if (cursor.done) {
      heap[0] = heap[heap.length - 1];
      heap.pop();
    }
    if (heap.length) down(0);
  }

  return skip;
}

// A reader of a sequence of buffers which hands out exact byte counts
function byteReader(source) {
  let buffer = Buffer.alloc(0);
  let ended = false;

  async function ensure(n) {
    while (buffer.length < n && !ended) {
      const next = await source.next();
      if (next.done) ended = true;
      else buffer = buffer.length ? Buffer.concat([buffer, next.value]) : next.value;
    }
    return buffer.length >= n;
  }

  return {
    ensure,
    peek: (n) => buffer.subarray(0, n),
    // Yields exactly n bytes in pieces
    async *piece(n) {
      let left = n;
      while (left > 0) {
        if (!buffer.length && !(await ensure(1))) throw new Error("The pack ended early");
        const take = Math.min(left, buffer.length);
        yield buffer.subarray(0, take);
        buffer = buffer.subarray(take);
        left -= take;
      }
    },
    skip(n) {
      return (async () => {
        let left = n;
        while (left > 0) {
          if (!buffer.length && !(await ensure(1))) throw new Error("The pack ended early");
          const take = Math.min(left, buffer.length);
          buffer = buffer.subarray(take);
          left -= take;
        }
      })();
    },
  };
}

function parseEntryHeader(bytes) {
  let i = 0;
  let byte = bytes[i++];
  const code = (byte >> 4) & 7;
  while (byte & 0x80) byte = bytes[i++];
  const headerLength = i;
  let ofsLength = 0;
  let distance = 0;
  if (code === 6) {
    let b = bytes[i++];
    distance = b & 0x7f;
    while (b & 0x80) {
      b = bytes[i++];
      distance = (distance + 1) * 128 + (b & 0x7f);
    }
    ofsLength = i - headerLength;
  }
  return { code, headerLength, ofsLength, distance };
}

function ofsEncode(distance) {
  const bytes = [distance & 0x7f];
  while ((distance = Math.floor(distance / 128))) {
    distance--;
    bytes.unshift(0x80 | (distance & 0x7f));
  }
  return Buffer.from(bytes);
}

// The pack to send, as an async iterable of Buffers. `plan` is from planPack.
async function* packStream(store, plan, stats = {}) {
  const hash = crypto.createHash("sha1");
  let position = 0;
  const out = (buffer) => {
    hash.update(buffer);
    position += buffer.length;
    return buffer;
  };

  const header = Buffer.alloc(12);
  header.write("PACK");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(plan.total, 8);
  yield out(header);

  // Small packs are started a couple ahead of the one being sent, so a
  // repository of many small packs isn't read one round trip at a time. A
  // large pack's reads are started when its turn comes.
  const opened = [];
  function open(p) {
    if (opened[p]) return opened[p];
    const pack = plan.send[p];
    const skip = plan.skip[p];
    const key = packKey(pack.name);
    const end = pack.size - 20;
    if (!skip.size) {
      opened[p] = { copy: chunks(store, key, 12, end) };
    } else {
      const first = Math.min(...skip.keys());
      const offsets = readOffsets(store, pack);
      offsets.catch(() => {});
      opened[p] = { first, offsets, copy: chunks(store, key, 12, first), walk: chunks(store, key, first, end) };
    }
    return opened[p];
  }

  for (let p = 0; p < plan.send.length; p++) {
    const pack = plan.send[p];
    const skip = plan.skip[p];
    const end = pack.size - 20;
    const packStart = position;
    const here = open(p);
    for (let q = p + 1; q <= p + PREFETCH_PACKS && q < plan.send.length; q++) if (plan.send[q].size <= SMALL_PACK) open(q);

    if (!skip.size) {
      for await (const buffer of here.copy) yield out(buffer);
      opened[p] = null;
      continue;
    }

    const first = here.first;
    for await (const buffer of here.copy) yield out(buffer);

    // Entries from the first skipped one on, in pack order
    const later = Array.from(await here.offsets).filter((o) => o >= first).sort((a, b) => a - b);
    const reader = byteReader(here.walk);
    const moved = new Map();
    const shift = (old) => (old < first ? packStart + (old - 12) : moved.get(old));

    for (let i = 0; i < later.length; i++) {
      const old = later[i];
      const length = (i + 1 < later.length ? later[i + 1] : end) - old;

      if (skip.has(old)) {
        await reader.skip(length);
        stats.skipped = (stats.skipped || 0) + 1;
        continue;
      }

      await reader.ensure(Math.min(length, 64));
      const info = parseEntryHeader(reader.peek(64));
      moved.set(old, position);

      if (info.code !== 6) {
        for await (const piece of reader.piece(length)) yield out(piece);
        continue;
      }

      const baseOld = old - info.distance;
      const head = Buffer.from(reader.peek(info.headerLength));
      await reader.skip(info.headerLength + info.ofsLength);
      if (skip.has(baseOld)) {
        head[0] = (head[0] & 0x8f) | (7 << 4);
        yield out(Buffer.concat([head, Buffer.from(skip.get(baseOld), "hex")]));
        stats.toRef = (stats.toRef || 0) + 1;
      } else {
        yield out(Buffer.concat([head, ofsEncode(position - shift(baseOld))]));
        stats.rewritten = (stats.rewritten || 0) + 1;
      }
      for await (const piece of reader.piece(length - info.headerLength - info.ofsLength)) yield out(piece);
    }
    opened[p] = null;
  }

  yield hash.digest();
}

// Works out what a stream of `send` (manifest pack entries, oldest first)
// holds: which entries to skip and so how many objects there are
async function planPack(store, send) {
  const skip = await planDedupe(store, send);
  const skipped = skip.reduce((n, map) => n + map.size, 0);
  const total = send.reduce((n, pack) => n + pack.objects, 0) - skipped;
  return { send, skip, total, skipped, bytes: send.reduce((n, p) => n + p.size - 32, 0) + 32 };
}

module.exports = { planPack, packStream, planDedupe, chunks };
