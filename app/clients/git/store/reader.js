// Reads objects by ID from a repository's live packs, entirely by range.
//
// An object is found by asking each pack's index (idx.js) for its offset; a
// pack entry is read with pack.js; a delta is resolved by reading its base,
// which is either earlier in the same pack (OFS_DELTA) or any object in any of
// the repository's packs (REF_DELTA, which is how the packs `index-pack
// --fix-thin` completes refer to what a push did not send).
//
// Memory is bounded by `maxSize`, the largest object a caller will hold. A
// delta chain is applied one link at a time, so it costs the base plus the
// chain's deltas plus the result, never the whole chain's intermediate
// objects. Every object read by ID is hashed and compared with the ID it was
// asked for, so bytes which are wrong in any way (a flipped bit, a bad offset,
// a truncated pack, a mismatched base) are an error rather than a result.
//
// `stream` is the exception to maxSize when the reader has `scratch`: an
// object stored as a delta which is too big to resolve in memory is built in
// files on local disk instead, a link of its chain at a time (see
// streamThroughScratch), so an object of any size costs bounded memory.
const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");
const { CorruptError, NotFoundError, TooLargeError } = require("./errors");
const { applyDelta, resultSize } = require("./delta");
const { applyDeltaToFile, writeFile } = require("./expand");
const { openIndex, chooseWhole } = require("./idx");
const { openPack, isDelta, recentReads } = require("./pack");
const { packKey, idxKey } = require("./layout");
const { mapLimit, createSemaphore } = require("./limit");

// Git's own limit on a chain is 4095; anything longer is a loop or an attack
const MAX_CHAIN = 5000;

const DEFAULT_MAX_SIZE = 64 * 1024 * 1024;

// How many packs' indexes are asked about one object at once (an index held
// whole answers from memory), and how many whole indexes are fetched at once
const LOOKUP_CONCURRENCY = 32;
const INDEX_CONCURRENCY = 64;

// Commits, trees and tags up to this size are kept in the cache by ID once
// read (and Blot's commits and pushes put theirs there), so the next commit,
// push or diff along the same paths reads none of them
const OBJECT_CACHE_MAX = 256 * 1024;
const CACHED_TYPES = { commit: 1, tree: 2, tag: 4 };

// How many object types a reader remembers it has seen in its packs
const MAX_TYPES = 65536;
const TYPE_BY_CODE = { 1: "commit", 2: "tree", 4: "tag" };

// How much of a delta's data is read to see how big its result is
const HEADER_BYTES = 32;

// The chunks an object built in scratch is streamed in
const FILE_CHUNK = 64 * 1024;

function objectHasher(type, size) {
  return crypto.createHash("sha1").update(type + " " + size + "\0");
}

// `packs` are manifest pack entries ({ name, size, idxSize }), oldest first.
// `cache` is optional: without it every lookup goes to the object store.
// `scratch` is optional too: an object with `reserve(bytes)` which resolves
// with a reservation (`dir`, `extend(bytes)`, `release()`), as cache.reserve
// does. With it, `stream` can stream a delta-stored object of any size;
// without it such an object is limited by `maxSize`, as it always was.
// If `scratch.maxBytes` is a number it is the whole of the room there could
// ever be, and an object which needs more is a TooLargeError rather than a
// NoRoomError (which means the room is taken just now). `scratchConcurrency`
// (default 1) is how many objects may be streamed through scratch at once.
//
// With a cache, `read` keeps the commits, trees and tags it reads there by ID
// (each checked against its ID when it comes back), and answers from it: the
// object is the same whichever pack holds it. A reader over only some of a
// repository's packs, which must not see objects the others hold, passes
// `objectCache: false`.
//
// Those entries are keyed by the manifest's `epoch` too, which a rewrite
// (rewrite.js) changes. A repository only loses objects in a rewrite, so
// within one epoch an object cached by ID is one the repository still has,
// and after a rewrite nothing cached before it is found. Give the reader the
// manifest its packs came from (`manifest`, in place of `packs` and `epoch`),
// or its `epoch` with the packs; without either the epoch is "", which is right
// only for a manifest without one.
function createReader({
  store,
  cache = null,
  manifest = null,
  packs = manifest && manifest.packs,
  epoch = (manifest && manifest.epoch) || "",
  maxSize = DEFAULT_MAX_SIZE,
  scratch = null,
  scratchConcurrency = 1,
  objectCache = true,
}) {
  if (!Array.isArray(packs))
    throw new Error(
      "createReader needs the packs, or the manifest they are in"
    );
  if (typeof epoch !== "string")
    throw new Error("A reader's epoch is a string");
  const scratchTurn = createSemaphore(scratchConcurrency);

  // Throws TooLargeError if `bytes` of scratch could never be had
  function mustFit(bytes, size) {
    if (typeof scratch.maxBytes === "number" && bytes > scratch.maxBytes) {
      const err = new TooLargeError(
        "Building an object of " +
          size +
          " bytes needs " +
          bytes +
          " bytes of scratch space, and there can never be more than " +
          scratch.maxBytes
      );
      err.size = size;
      throw err;
    }
  }

  const whole = chooseWhole(packs, cache);
  const recent = recentReads();
  const opened = packs.map((entry) => ({
    name: entry.name,
    pack: openPack({
      store,
      key: packKey(entry.name),
      size: entry.size,
      name: entry.name,
      recent,
      cache,
    }),
    index: openIndex({
      store,
      key: idxKey(entry.name),
      size: entry.idxSize,
      cache,
      namespace: store.id,
      whole: whole.has(entry.name),
    }),
  }));
  const byName = new Map(opened.map((p) => [p.name, p]));

  // The indexes read whole are all fetched at once, on the first lookup, so a
  // repository of many packs costs one round of GETs (none once cached), not
  // one per pack per lookup
  let loading = null;
  function loadIndexes() {
    if (!loading) {
      loading = mapLimit(
        opened.filter((p) => p.index.whole),
        INDEX_CONCURRENCY,
        (p) => p.index.load()
      ).catch((err) => {
        loading = null;
        throw err;
      });
    }
    return loading;
  }

  // Where object `oid` is: { pack, offset } in the newest pack holding it, or
  // null. Every pack is asked at once, since each answer may be a cache hit.
  async function locate(oid) {
    await loadIndexes();
    const offsets = await mapLimit(opened, LOOKUP_CONCURRENCY, (p) =>
      p.index.lookup(oid)
    );
    for (let i = opened.length - 1; i >= 0; i--) {
      if (offsets[i] !== null) return { pack: opened[i], offset: offsets[i] };
    }
    return null;
  }

  // Follows a delta's base: an offset in the same pack, or an ID anywhere
  async function baseOf(at, entry) {
    if (entry.baseOffset !== undefined)
      return { pack: at.pack, offset: entry.baseOffset };

    const found = await locate(entry.baseOid);
    if (!found)
      throw new NotFoundError(
        "Delta base " + entry.baseOid + " is not in any pack"
      );
    return found;
  }

  // Resolves the entry at `start` ({ pack, offset }) to a whole object
  async function resolve(start, limit = maxSize) {
    const deltas = [];
    const visited = new Set();
    let held = 0;
    let at = start;
    let base;

    for (;;) {
      const id = at.pack.name + ":" + at.offset;
      if (visited.has(id) || visited.size >= MAX_CHAIN)
        throw new CorruptError("Delta chain does not end");
      visited.add(id);

      const entry = await at.pack.pack.read(at.offset, limit);
      if (!isDelta(entry)) {
        base = entry;
        break;
      }

      held += entry.data.length;
      if (held > limit)
        throw new TooLargeError(
          "Delta chain is larger than " + limit + " bytes"
        );
      deltas.push(entry.data);
      at = await baseOf(at, entry);
    }

    let data = base.data;
    for (let i = deltas.length - 1; i >= 0; i--)
      data = applyDelta(data, deltas[i], limit);
    return { type: base.type, data };
  }

  function check(oid, type, data) {
    const hash = objectHasher(type, data.length).update(data).digest("hex");
    if (hash !== oid)
      throw new CorruptError("Object " + oid + " read back as " + hash);
  }

  async function has(oid) {
    return (await locate(oid)) !== null;
  }

  // The type of object `oid` ("commit", "tree", "blob" or "tag"), or null if
  // no pack has it. Only entry headers are read: the one at the object, and for
  // a delta the headers of its bases until one is not a delta. That is a
  // single small read when the object is stored whole. The data is not
  // inflated, so unlike read() this does not check the object against its ID.
  //
  // It always asks the packs, never the cache of objects: receive's check
  // that what a push links to exists relies on it.
  async function typeOf(oid) {
    if (packTypes.has(oid)) return packTypes.get(oid);

    let at = await locate(oid);
    if (!at) return null;

    for (let steps = 0; steps < MAX_CHAIN; steps++) {
      const entry = await at.pack.pack.open(at.offset);
      entry.output.return();
      if (!isDelta(entry)) {
        noteType(oid, entry.type);
        return entry.type;
      }
      at = await baseOf(at, entry);
    }
    throw new CorruptError("Delta chain does not end");
  }

  // The types of the objects this reader has found in its packs (read or
  // typeOf), so it does not ask the packs again. Never filled from the cache.
  // The oldest are forgotten past MAX_TYPES.
  const packTypes = new Map();
  const noteType = (oid, type) => {
    packTypes.set(oid, type);
    if (packTypes.size > MAX_TYPES)
      packTypes.delete(packTypes.keys().next().value);
  };

  // The object `oid` as { type, size, data }, or null if no pack has it.
  // Throws CorruptError if what the packs hold for it is not it.
  async function read(oid, { maxSize: limit = maxSize } = {}) {
    const known = await cachedObject(oid);
    if (known && known.data.length <= limit) return known;

    // Concurrent reads of one object (a prefetch and the read it was for)
    // share one
    const flight = limit + ":" + oid;
    if (!reading.has(flight)) {
      reading.set(
        flight,
        (async () => {
          const at = await locate(oid);
          if (!at) return null;

          const { type, data } = await resolve(at, limit);
          check(oid, type, data);
          noteType(oid, type);
          await remember(oid, type, data);
          return { type, size: data.length, data };
        })().finally(() => reading.delete(flight))
      );
    }
    return reading.get(flight);
  }

  const reading = new Map();
  // Without an epoch the key is what it always was
  const objectKey = (oid) =>
    store.id + "/obj/" + (epoch ? epoch + "/" : "") + oid;

  // A commit, tree or tag from the cache, checked against its ID, or null
  async function cachedObject(oid) {
    if (!cache || !objectCache) return null;
    const hit = await cache.get(objectKey(oid)).catch(() => null);
    if (!hit || !hit.length || !TYPE_BY_CODE[hit[0]]) return null;
    const type = TYPE_BY_CODE[hit[0]];
    const data = hit.subarray(1);
    if (objectHasher(type, data.length).update(data).digest("hex") !== oid)
      return null;
    return { type, size: data.length, data };
  }

  // Keeps a commit, tree or tag in the cache by ID. `data` must be the object
  // `oid` is; a caller other than read() passes what it has just hashed or
  // written itself.
  async function remember(oid, type, data) {
    if (
      !cache ||
      !objectCache ||
      !CACHED_TYPES[type] ||
      data.length > OBJECT_CACHE_MAX
    )
      return false;
    return cache
      .put(
        objectKey(oid),
        Buffer.concat([Buffer.from([CACHED_TYPES[type]]), data])
      )
      .catch(() => false);
  }

  // The size of the object a delta entry builds, from the start of its data
  async function targetSize(entry) {
    const iterator = entry.output[Symbol.asyncIterator]();
    let head = Buffer.alloc(0);
    try {
      while (head.length < HEADER_BYTES) {
        const next = await iterator.next();
        if (next.done) break;
        head = Buffer.concat([head, next.value]);
      }
    } finally {
      await iterator.return();
    }
    return resultSize(head);
  }

  // Streams the object stored as a delta at `start` by building it in files
  // in scratch, with memory that does not depend on its size.
  //
  // The chain is walked to its base, which is stored whole, and the base is
  // written to a file. Each delta from the base outwards is then applied to the
  // file before it, writing a new one (expand.js) and deleting the old, so
  // there are never more than two copies on disk. The last file is streamed to
  // the caller and deleted.
  //
  // Room for the files is taken from `scratch` as it becomes known: the base's
  // size first, and then, for each link, the size of its result (it is in the
  // delta's header) on top of the file it is applied to. Room which is not
  // there is a NoRoomError. The reservation is released, and the files with it,
  // on every way out: a failure here, the end of the stream, an error in it, or
  // the consumer abandoning it (`return()` on the iterator, which `for await`
  // does on a `break` and a Readable does when it is destroyed).
  //
  // The object is hashed as the file streams out, exactly as for an object
  // stored whole: the iteration throws CorruptError at its end if what came out
  // is not `oid`. A delta which does not fit its base, or is not valid data,
  // fails here instead, before the stream is returned.
  async function streamThroughScratch(oid, start) {
    const turn = await scratchTurn();
    let given = false;
    const release = () => {
      if (!given) {
        given = true;
        turn();
      }
    };

    try {
      return await buildInScratch(oid, start, release);
    } catch (err) {
      release();
      throw err;
    }
  }

  async function buildInScratch(oid, start, release) {
    const chain = [];
    const visited = new Set();
    let at = start;
    let base;

    for (;;) {
      const id = at.pack.name + ":" + at.offset;
      if (visited.has(id) || visited.size >= MAX_CHAIN)
        throw new CorruptError("Delta chain does not end");
      visited.add(id);

      const entry = await at.pack.pack.open(at.offset);
      if (!isDelta(entry)) {
        base = entry;
        break;
      }

      entry.output.return();
      chain.push(at);
      at = await baseOf(at, entry);
    }

    mustFit(base.size, base.size);
    const reservation = await scratch.reserve(base.size);
    let reserved = base.size;
    let handle = null;
    let cleaned = null;

    // Idempotent
    function cleanup() {
      if (!cleaned) {
        cleaned = (async () => {
          if (handle) await handle.close().catch(() => {});
          try {
            await reservation.release();
          } finally {
            release();
          }
        })();
      }
      return cleaned;
    }

    try {
      let current = path.join(reservation.dir, "0");
      let size = await writeFile(current, base.output);
      if (size !== base.size)
        throw new CorruptError(
          "Pack entry at " + base.offset + " is not the size its header says"
        );

      for (let i = chain.length - 1; i >= 0; i--) {
        const entry = await chain[i].pack.pack.open(chain[i].offset);
        const next = path.join(reservation.dir, String(chain.length - i));
        const before = size;

        size = await applyDeltaToFile({
          source: current,
          sourceSize: before,
          delta: entry.output,
          target: next,
          // Both files exist while the delta is applied
          room: async (target) => {
            mustFit(before + target, Math.max(before, target));
            if (before + target > reserved) {
              await reservation.extend(before + target - reserved);
              reserved = before + target;
            }
          },
        });

        await fsp.rm(current, { force: true });
        current = next;
      }

      handle = await fsp.open(current, "r");
      const file = handle;
      const length = size;
      const hash = objectHasher(base.type, length);

      async function* verified() {
        try {
          for (let read = 0; read < length;) {
            const chunk = Buffer.allocUnsafe(
              Math.min(FILE_CHUNK, length - read)
            );
            const { bytesRead } = await file.read(chunk, 0, chunk.length, read);
            if (!bytesRead)
              throw new CorruptError(
                "Object " + oid + " was cut short in scratch space"
              );
            read += bytesRead;
            hash.update(chunk.subarray(0, bytesRead));
            yield chunk.subarray(0, bytesRead);
          }
          if (hash.digest("hex") !== oid)
            throw new CorruptError(
              "Object " + oid + " read back as a different object"
            );
        } finally {
          await cleanup();
        }
      }

      // return() on a generator which was never started doesn't run its
      // finally, so the files are released here for a stream nobody read
      const generator = verified();
      let started = false;
      const iterator = {
        [Symbol.asyncIterator]: () => iterator,
        next: (value) => {
          started = true;
          return generator.next(value);
        },
        async return(value) {
          if (!started) await cleanup();
          return generator.return(value);
        },
        async throw(err) {
          if (!started) await cleanup();
          return generator.throw(err);
        },
      };

      return { type: base.type, size: length, data: iterator };
    } catch (err) {
      await cleanup();
      throw err;
    }
  }

  // Like read, but the data is an async iterable of chunks when the object is
  // stored whole, so an object of any size costs bounded memory. The chunks
  // are hashed as they go: the iteration throws CorruptError at its end if the
  // object isn't `oid`, so the caller must not treat the data as good until
  // then. An object stored as a delta is resolved in memory, and so is
  // limited by maxSize, unless the reader has `scratch`: then one over the
  // limit is built in files (streamThroughScratch). Smaller ones are still
  // resolved in memory, which is cheaper.
  async function stream(oid, { maxSize: limit = maxSize } = {}) {
    // A commit, tree or tag kept in the cache (a push's delta bases are often
    // the trees of the push before) was checked against its ID as it came out
    const known = await cachedObject(oid);
    if (known && known.data.length <= limit) {
      return {
        type: known.type,
        size: known.size,
        data: (async function* () {
          yield known.data;
        })(),
      };
    }

    const at = await locate(oid);
    if (!at) return null;

    const entry = await at.pack.pack.open(at.offset);
    if (isDelta(entry)) {
      if (!scratch) entry.output.return();
      else if ((await targetSize(entry)) > limit)
        return streamThroughScratch(oid, at);

      let resolved;
      try {
        resolved = await resolve(at, limit);
      } catch (err) {
        // The result fits but something it is built from does not
        if (scratch && err instanceof TooLargeError)
          return streamThroughScratch(oid, at);
        throw err;
      }

      check(oid, resolved.type, resolved.data);
      return {
        type: resolved.type,
        size: resolved.data.length,
        data: (async function* () {
          yield resolved.data;
        })(),
      };
    }

    const hash = objectHasher(entry.type, entry.size);
    async function* verified() {
      for await (const chunk of entry.output) {
        hash.update(chunk);
        yield chunk;
      }
      if (hash.digest("hex") !== oid)
        throw new CorruptError(
          "Object " + oid + " read back as a different object"
        );
    }
    return { type: entry.type, size: entry.size, data: verified() };
  }

  return {
    packs: opened.map((p) => p.name),
    epoch,
    has,
    locate,
    typeOf,
    read,
    stream,
    remember,
    pack: (name) => byName.get(name),
  };
}

module.exports = createReader;
