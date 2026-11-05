// An object store held in memory, for specs. It has the same interface as the
// S3 store (see s3.js) and counts what is asked of it, so a spec can check how
// many round trips an operation took.
//
// The object store interface (keys are relative to the repository):
//
//   head(key)                       -> { size, lastModified } | null, where
//                                      lastModified is when the object was
//                                      last written, in ms since the epoch
//                                      (S3 keeps whole seconds)
//   read(key, offset, length)       -> Buffer; a range, shorter if it runs past
//                                      the end, empty if it starts past it
//   get(key, { maxBytes })          -> Buffer of the whole object, for small
//                                      ones; throws TooLargeError over maxBytes
//   get(key, { maxBytes, ifNoneMatch })
//                                   -> a conditional GET (If-None-Match):
//                                      { notModified: true, etag } while the
//                                      object's ETag is still ifNoneMatch,
//                                      and otherwise { bytes, etag }, etag
//                                      being its ETag now (null if the store
//                                      gave none). ifNoneMatch null asks for
//                                      the bytes and the ETag. The ETag
//                                      changes whenever the bytes do; two
//                                      writes of the same bytes may share one.
//   stream(key, offset?, length?)   -> Readable of the object or a range of it;
//                                      a missing key is the stream's error
//   put(key, body)                  -> body is a Buffer, or a Readable /
//                                      async iterable of Buffers of any size
//   putIfAbsent(key, buffer)        -> true if this call created the key, false
//                                      if it already existed (and is left as
//                                      it was). Of several racing writers of
//                                      one key, exactly one gets true.
//   delete(key)                     -> nothing if it was already gone
//   list(prefix)                    -> async iterable of { key, size,
//                                      lastModified }, in key order
//   id                              -> a string naming this store, which
//                                      namespaces what the cache holds for it
//
// A missing key makes read and get throw NotFoundError (stream errors with it).
//
// createMemoryStore({ now }) takes the clock that stamps lastModified (default
// Date.now), so a spec can move time on without waiting.
const crypto = require("crypto");
const { Readable } = require("stream");
const { NotFoundError, TooLargeError } = require("../errors");

let created = 0;

// An ETag as S3 gives one for an object written in a single PUT: the MD5 of
// its bytes, quoted
function etagOf(bytes) {
  return '"' + crypto.createHash("md5").update(bytes).digest("hex") + '"';
}

async function collect(body) {
  if (Buffer.isBuffer(body)) return Buffer.from(body);
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function createMemoryStore({ now = Date.now } = {}) {
  const objects = new Map();
  const modified = new Map();
  const id = "memory:" + ++created;
  const stats = { heads: 0, reads: 0, bytesRead: 0, gets: 0, notModified: 0, puts: 0, putIfAbsents: 0, deletes: 0, lists: 0 };

  function find(key) {
    const object = objects.get(key);
    if (!object) throw new NotFoundError("No such key: " + key);
    return object;
  }

  async function head(key) {
    stats.heads++;
    const object = objects.get(key);
    return object ? { size: object.length, lastModified: modified.get(key) } : null;
  }

  async function read(key, offset, length) {
    const object = find(key);
    stats.reads++;
    const slice = Buffer.from(object.subarray(offset, offset + length));
    stats.bytesRead += slice.length;
    return slice;
  }

  // A 304 is a GET too, so it counts in `gets` as well as `notModified`. As
  // on S3, the condition is answered before the size is looked at.
  async function get(key, { maxBytes = Infinity, ifNoneMatch } = {}) {
    const object = find(key);
    const conditional = ifNoneMatch !== undefined;
    const etag = conditional ? etagOf(object) : null;
    if (conditional && ifNoneMatch && ifNoneMatch === etag) {
      stats.gets++;
      stats.notModified++;
      return { notModified: true, etag };
    }
    if (object.length > maxBytes) throw new TooLargeError(key + " is larger than " + maxBytes);
    stats.gets++;
    stats.bytesRead += object.length;
    return conditional ? { bytes: Buffer.from(object), etag } : Buffer.from(object);
  }

  function stream(key, offset = 0, length = Infinity) {
    async function* chunks() {
      const object = find(key);
      stats.reads++;
      const slice = object.subarray(offset, offset + length);
      stats.bytesRead += slice.length;
      yield Buffer.from(slice);
    }
    return Readable.from(chunks(), { objectMode: false });
  }

  async function put(key, body) {
    const bytes = await collect(body);
    objects.set(key, bytes);
    modified.set(key, now());
    stats.puts++;
  }

  // No await between the check and the set, so racing writers can't both win
  async function putIfAbsent(key, buffer) {
    stats.putIfAbsents++;
    if (objects.has(key)) return false;
    objects.set(key, Buffer.from(buffer));
    modified.set(key, now());
    return true;
  }

  async function remove(key) {
    stats.deletes++;
    objects.delete(key);
    modified.delete(key);
  }

  async function* list(prefix = "") {
    stats.lists++;
    for (const key of [...objects.keys()].sort()) {
      // A key deleted while the listing is read is left out, as S3 may
      const object = objects.get(key);
      if (object && key.startsWith(prefix)) yield { key, size: object.length, lastModified: modified.get(key) };
    }
  }

  return { id, stats, head, read, get, stream, put, putIfAbsent, delete: remove, list, objects };
}

module.exports = createMemoryStore;
