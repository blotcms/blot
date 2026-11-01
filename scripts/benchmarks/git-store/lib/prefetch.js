// Batched, coalesced reads of pack entries, for the harness.
//
// The foundation reads one object at a time. A caller which knows it wants
// many objects (the trees of one level of a diff, the changed blobs of a
// materialize, the delta bases of a push) can do much better: find where each
// starts (an index lookup, cached after the first), then read a first window
// at each offset with the nearby windows merged into single requests. The
// reader then finds its first read of each entry already in memory.
//
// This is a decorator on the store, so the reader needs no change. An entry's
// end is not known without inflating it, so the window is a guess; an entry
// longer than the window, or a delta chain's bases, cost further reads.
const { readRanges } = require("../../../../app/clients/git/store");
const { packKey } = require("../../../../app/clients/git/store").layout;
const { mapLimit } = require("../../../../app/clients/git/store/limit");

const WINDOW = 16 * 1024;

function withPrefetch(store) {
  const windows = new Map();

  async function read(key, offset, length) {
    const list = windows.get(key);
    if (list) {
      for (const w of list) {
        if (offset >= w.offset && offset + length <= w.offset + w.buffer.length) {
          return w.buffer.subarray(offset - w.offset, offset - w.offset + length);
        }
      }
    }
    return store.read(key, offset, length);
  }

  // Reads the first window of each of `oids`' entries. `reader` finds them.
  async function prefetch(reader, oids, { window = WINDOW } = {}) {
    const found = await mapLimit(oids, 8, (oid) => reader.locate(oid));
    const byPack = new Map();
    for (const at of found) {
      if (!at) continue;
      const key = packKey(at.pack.name);
      if (!byPack.has(key)) byPack.set(key, new Set());
      byPack.get(key).add(at.offset);
    }
    await Promise.all(
      [...byPack].map(async ([key, offsets]) => {
        const ranges = [...offsets].map((offset) => ({ offset, length: window }));
        const buffers = await readRanges(store, key, ranges);
        const list = windows.get(key) || [];
        ranges.forEach((range, i) => list.push({ offset: range.offset, buffer: buffers[i] }));
        windows.set(key, list);
      })
    );
  }

  return {
    ...store,
    id: store.id,
    read,
    prefetch,
    forget: () => windows.clear(),
  };
}

module.exports = withPrefetch;
