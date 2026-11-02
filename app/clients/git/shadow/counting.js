// Wraps an object store (see ../store/objectStore/memory.js for the interface)
// to count, for each shadow operation, the requests it made and the bytes it
// sent and received, for the timing logs.
//
// The wrapper must be the same object for the life of a blog's store, because
// the store keeps its memos (manifest bytes, pack sizes) by object identity. A
// compaction can run while a mirror does, on the same store, so the counts go
// to whichever operation the call was made in, found with AsyncLocalStorage:
//
//   const store = counting(inner);
//   const { result, counts } = await measure(() => receive({ store, ... }));
//   counts  { requests, bytesUp, bytesDown }
//
// A call outside measure() is not counted. A stream is counted as it is read,
// and an upload of a stream as it is consumed.
const { AsyncLocalStorage } = require("async_hooks");
const { Transform, pipeline } = require("stream");

const current = new AsyncLocalStorage();

function counts() {
  return { requests: 0, bytesUp: 0, bytesDown: 0 };
}

async function measure(fn) {
  const tally = counts();
  const started = Date.now();
  const result = await current.run(tally, fn);
  return { result, counts: tally, ms: Date.now() - started };
}

function size(body) {
  return Buffer.isBuffer(body) || body instanceof Uint8Array ? body.length : 0;
}

// An upload's body as it is read, counted
function countedBody(body, tally) {
  if (!body || Buffer.isBuffer(body) || body instanceof Uint8Array) {
    tally.bytesUp += size(body);
    return body;
  }

  return (async function* () {
    for await (const chunk of body) {
      tally.bytesUp += chunk.length;
      yield chunk;
    }
  })();
}

// A download's stream, counted as it is read. pipeline passes an error or an
// early end either way, as the store's own stream would have.
function countedStream(source, tally) {
  const through = new Transform({
    transform(chunk, encoding, callback) {
      tally.bytesDown += chunk.length;
      callback(null, chunk);
    },
  });

  pipeline(source, through, () => {});

  return through;
}

function counting(inner) {
  const wrapped = { id: inner.id };

  const tally = () => current.getStore() || null;

  wrapped.head = (key) => {
    const t = tally();
    if (t) t.requests++;
    return inner.head(key);
  };

  wrapped.read = async (key, offset, length) => {
    const t = tally();
    if (t) t.requests++;
    const buffer = await inner.read(key, offset, length);
    if (t) t.bytesDown += size(buffer);
    return buffer;
  };

  wrapped.get = async (key, options) => {
    const t = tally();
    if (t) t.requests++;
    const buffer = await inner.get(key, options);
    if (t) t.bytesDown += size(buffer);
    return buffer;
  };

  wrapped.stream = (key, offset, length) => {
    const t = tally();
    const stream = inner.stream(key, offset, length);
    if (!t) return stream;
    t.requests++;
    return countedStream(stream, t);
  };

  wrapped.put = (key, body) => {
    const t = tally();
    if (!t) return inner.put(key, body);
    t.requests++;
    return inner.put(key, countedBody(body, t));
  };

  wrapped.putIfAbsent = (key, buffer) => {
    const t = tally();
    if (t) {
      t.requests++;
      t.bytesUp += size(buffer);
    }
    return inner.putIfAbsent(key, buffer);
  };

  wrapped.delete = (key) => {
    const t = tally();
    if (t) t.requests++;
    return inner.delete(key);
  };

  wrapped.list = (prefix) => {
    const t = tally();
    if (t) t.requests++;
    return inner.list(prefix);
  };

  return wrapped;
}

module.exports = counting;
module.exports.measure = measure;
