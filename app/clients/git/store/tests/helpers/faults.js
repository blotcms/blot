// An object store which misbehaves on a schedule the spec sets, around any
// other object store (the in-memory one, usually). Not a spec itself.
//
//   const store = faults(createMemoryStore());
//   store.inject("putIfAbsent", { key: /manifests\/0*2\.json$/, after: new Error("ECONNRESET") });
//
// inject(op, fault) schedules a fault for the next call of `op` ("head",
// "read", "get", "stream", "put", "putIfAbsent", "delete" or "list"). The
// fault is one of:
//
//   { before: err }      throws without applying anything
//   { after: err }       applies the call, then throws: the response was lost
//   { result: value }    applies the call, then answers `value` instead: what
//                        a retry which finds its own write answers, say
//   { truncate: n }      read, get, stream: only the first n bytes of the body
//                        (or truncate(body) for a function; a stream just
//                        ends, as if the connection closed cleanly). With
//                        `after` on a stream, it then fails.
//   { answer: value }    head, get, read: answers `value` (throws it, if it is
//                        an Error) without asking the store: a stale answer
//
// plus `delay: ms` on any of them, to wait first. Options: `key` (a string or
// RegExp, default any key), `skip` (let this many matching calls through
// first) and `times` (how many calls it applies to, default 1). Faults which
// match are used in the order they were injected. `calls` lists "op key" for
// every call, in order. Everything else the wrapped store has (id, stats,
// objects) is passed through.
const { Readable } = require("stream");

const OPS = [
  "head",
  "read",
  "get",
  "stream",
  "put",
  "putIfAbsent",
  "delete",
  "list",
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function matches(want, key) {
  if (want === undefined) return true;
  return want instanceof RegExp ? want.test(key) : want === key;
}

function cut(body, truncate) {
  return body.subarray(
    0,
    typeof truncate === "function" ? truncate(body) : truncate
  );
}

function createFaultyStore(inner) {
  const schedule = [];
  const wrapped = {
    ...inner,
    calls: [],
    inject,
    pending: () => schedule.length,
  };

  function inject(op, fault) {
    if (!OPS.includes(op)) throw new Error("No such operation: " + op);
    schedule.push({ op, times: 1, skip: 0, ...fault });
    return wrapped;
  }

  function take(op, key) {
    wrapped.calls.push(op + " " + key);
    const at = schedule.findIndex((f) => f.op === op && matches(f.key, key));
    if (at < 0) return null;

    const fault = schedule[at];
    if (fault.skip > 0) {
      fault.skip--;
      return null;
    }
    if (--fault.times <= 0) schedule.splice(at, 1);
    return fault;
  }

  function wrap(op) {
    wrapped[op] = async (key, ...args) => {
      const fault = take(op, key);
      if (!fault) return inner[op](key, ...args);

      if (fault.delay) await sleep(fault.delay);
      if ("answer" in fault) {
        if (fault.answer instanceof Error) throw fault.answer;
        return fault.answer;
      }
      if (fault.before) throw fault.before;

      const out = await inner[op](key, ...args);
      if (fault.after) throw fault.after;
      if ("result" in fault) return fault.result;
      if (fault.truncate !== undefined && Buffer.isBuffer(out))
        return cut(out, fault.truncate);
      return out;
    };
  }

  for (const op of ["head", "read", "get", "put", "putIfAbsent", "delete"])
    wrap(op);

  wrapped.stream = (key, ...args) => {
    const fault = take("stream", key);
    if (!fault) return inner.stream(key, ...args);

    async function* chunks() {
      if (fault.delay) await sleep(fault.delay);
      if (fault.before) throw fault.before;

      if (fault.truncate === undefined) {
        yield* inner.stream(key, ...args);
      } else {
        // The body is read whole so a function can decide where to cut it
        const whole = [];
        for await (const chunk of inner.stream(key, ...args))
          whole.push(Buffer.from(chunk));
        yield cut(Buffer.concat(whole), fault.truncate);
      }
      if (fault.after) throw fault.after;
    }
    return Readable.from(chunks(), { objectMode: false });
  };

  wrapped.list = async function* (prefix) {
    const fault = take("list", prefix);
    if (fault && fault.delay) await sleep(fault.delay);
    if (fault && fault.before) throw fault.before;
    yield* inner.list(prefix);
    if (fault && fault.after) throw fault.after;
  };

  return wrapped;
}

module.exports = createFaultyStore;
