// Wraps an object store (see ../store/objectStore/memory.js for the interface)
// to count, for each operation on the git store, the requests it made and the
// bytes it sent and received, for the log lines (./log.js).
//
// The wrapper must be the same object for the life of a blog's store, because
// the store keeps its memos (manifest bytes, pack sizes) by object identity. A
// compaction can run while a push does, on the same store, so the counts go
// to whichever operation the call was made in, found with AsyncLocalStorage:
//
//   const store = counting(inner);
//   const { result, counts } = await measure(() => receive({ store, ... }));
//   counts  { requests, bytesUp, bytesDown, waitMs }
//
// A call outside measure() is not counted. A stream is counted as it is read,
// and an upload of a stream as it is consumed. Each call counts as one request
// unless the store counts its own (countsOwnRequests: true) by calling sent()
// for each request it sends: the S3 store does, since one put of a large pack
// is several requests, and a list may be several pages.
//
// It also keeps the operation's lane clock: how long it spent with a git
// command waiting for a place in the git limiter (../limiter.js), recorded by
// waiting() below. waitMs is the time during which at least one of the
// operation's commands was waiting, so two waiting at once count once. The ms
// measure() returns, and a stopwatch(), leave that time out, so the figures
// are the work alone however busy the lane was.
const { AsyncLocalStorage } = require("async_hooks");
const { Transform, pipeline } = require("stream");

const current = new AsyncLocalStorage();

// tally -> { total, waiting, since }: the lane clock of an operation
const clocks = new WeakMap();

function counts() {
  return { requests: 0, bytesUp: 0, bytesDown: 0, waitMs: 0 };
}

// How long the operation (the current one, or the tally's) has waited so far,
// a wait still going on included
function waitedSoFar(tally) {
  tally = tally || current.getStore();
  const clock = tally && clocks.get(tally);
  if (!clock) return 0;
  return clock.total + (clock.waiting ? Date.now() - clock.since : 0);
}

// A git command of the current operation starts waiting for a place. Returns
// a function to call once it has one (calling it again does nothing).
function waiting() {
  const tally = current.getStore();
  const clock = tally && clocks.get(tally);
  if (!clock) return () => {};

  if (clock.waiting++ === 0) clock.since = Date.now();

  let granted = false;
  return () => {
    if (granted) return;
    granted = true;
    if (--clock.waiting === 0) clock.total += Date.now() - clock.since;
    tally.waitMs = clock.total;
  };
}

// Starts timing part of the current operation. Returns a function which gives
// the ms since, less the operation's lane waits in between.
function stopwatch() {
  const tally = current.getStore();
  const started = Date.now();
  const waitedBefore = waitedSoFar(tally);
  return () => Date.now() - started - (waitedSoFar(tally) - waitedBefore);
}

async function measure(fn) {
  const tally = counts();
  clocks.set(tally, { total: 0, waiting: 0, since: 0 });
  const elapsed = current.run(tally, stopwatch);
  const result = await current.run(tally, fn);
  tally.waitMs = waitedSoFar(tally);
  return { result, counts: tally, ms: elapsed() };
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

// One request sent by a store which counts its own, in the current operation
function sent() {
  const t = current.getStore();
  if (t) t.requests++;
}

function counting(inner) {
  const wrapped = { id: inner.id };

  const tally = () => current.getStore() || null;
  const request = inner.countsOwnRequests ? () => {} : (t) => t.requests++;

  wrapped.head = (key) => {
    const t = tally();
    if (t) request(t);
    return inner.head(key);
  };

  wrapped.read = async (key, offset, length) => {
    const t = tally();
    if (t) request(t);
    const buffer = await inner.read(key, offset, length);
    if (t) t.bytesDown += size(buffer);
    return buffer;
  };

  wrapped.get = async (key, options) => {
    const t = tally();
    if (t) request(t);
    const buffer = await inner.get(key, options);
    if (t) t.bytesDown += size(buffer);
    return buffer;
  };

  wrapped.stream = (key, offset, length) => {
    const t = tally();
    const stream = inner.stream(key, offset, length);
    if (!t) return stream;
    request(t);
    return countedStream(stream, t);
  };

  wrapped.put = (key, body) => {
    const t = tally();
    if (!t) return inner.put(key, body);
    request(t);
    return inner.put(key, countedBody(body, t));
  };

  wrapped.putIfAbsent = (key, buffer) => {
    const t = tally();
    if (t) {
      request(t);
      t.bytesUp += size(buffer);
    }
    return inner.putIfAbsent(key, buffer);
  };

  wrapped.delete = (key) => {
    const t = tally();
    if (t) request(t);
    return inner.delete(key);
  };

  wrapped.list = (prefix) => {
    const t = tally();
    if (t) request(t);
    return inner.list(prefix);
  };

  return wrapped;
}

module.exports = counting;
module.exports.measure = measure;
module.exports.sent = sent;
module.exports.waiting = waiting;
module.exports.stopwatch = stopwatch;
