// Counts what a run asks of S3, at two levels:
//
//   ops   what the store code asked (read, head, get, stream, put, list,
//         delete) and the bytes it moved. A multipart put is one op here.
//   http  what actually went to the endpoint, one entry per request attempt
//         by SDK command (GetObject, HeadObject, PutObject, UploadPart ...),
//         counting retries, with the request and response sizes the headers
//         declared. bytesIn and bytesOut are the totals of these.
//
// The http counts are the ones to quote as "requests". They are taken as the
// request leaves the SDK, so they include the requests a failure injection
// breaks.
const { PassThrough } = require("stream");

function emptyCounts() {
  return { ops: {}, http: {}, bytesIn: 0, bytesOut: 0 };
}

function bump(table, name, bytes = 0) {
  const row = table[name] || (table[name] = { n: 0, bytes: 0 });
  row.n++;
  row.bytes += bytes;
}

function createCounters() {
  let counts = emptyCounts();

  return {
    // Hands back what was counted since the last call
    take() {
      const taken = counts;
      counts = emptyCounts();
      return taken;
    },
    op(name, bytes) {
      bump(counts.ops, name, bytes);
    },
    bytes(name, bytes) {
      const row = counts.ops[name] || (counts.ops[name] = { n: 0, bytes: 0 });
      row.bytes += bytes;
    },
    http(name, requestBytes, responseBytes) {
      bump(counts.http, name, responseBytes);
      counts.http[name].requestBytes = (counts.http[name].requestBytes || 0) + requestBytes;
      counts.bytesOut += requestBytes;
      counts.bytesIn += responseBytes;
    },
  };
}

// Counts every attempt the SDK makes
function instrumentClient(client, counters) {
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const headers = (args.request && args.request.headers) || {};
      const requestBytes = Number(headers["content-length"] || 0);
      try {
        const out = await next(args);
        // A HEAD answer carries the object's length in content-length but no body
        const responseBytes = context.commandName === "HeadObjectCommand" ? 0 : Number((out.response && out.response.headers && out.response.headers["content-length"]) || 0);
        counters.http(context.commandName, requestBytes, responseBytes);
        return out;
      } catch (err) {
        counters.http(context.commandName, requestBytes, 0);
        throw err;
      }
    },
    { step: "finalizeRequest", name: "countAttempts", priority: "low" }
  );
  return client;
}

// Wraps an object store so every call is counted
function countStore(store, counters) {
  function counted(body, name) {
    if (Buffer.isBuffer(body)) {
      counters.bytes(name, body.length);
      return body;
    }
    const through = new PassThrough();
    through.on("data", (chunk) => counters.bytes(name, chunk.length));
    body.on("error", (err) => through.destroy(err));
    return body.pipe(through);
  }

  return {
    id: store.id,
    raw: store,
    async head(key) {
      counters.op("head", 0);
      return store.head(key);
    },
    async read(key, offset, length) {
      // split by what was read, so a table can say how much of the traffic is
      // index lookups
      const name = key.endsWith(".idx") ? "read.idx" : key.endsWith(".pack") ? "read.pack" : "read.other";
      counters.op(name, 0);
      const buffer = await store.read(key, offset, length);
      counters.bytes(name, buffer.length);
      return buffer;
    },
    async get(key, options) {
      counters.op("get", 0);
      const buffer = await store.get(key, options);
      counters.bytes("get", buffer.length);
      return buffer;
    },
    stream(key, offset, length) {
      counters.op("stream", 0);
      const source = store.stream(key, offset, length);
      const through = new PassThrough();
      through.on("data", (chunk) => counters.bytes("stream", chunk.length));
      source.on("error", (err) => through.destroy(err));
      return source.pipe(through);
    },
    async put(key, body) {
      counters.op("put", 0);
      return store.put(key, counted(body, "put"));
    },
    async putIfAbsent(key, body) {
      counters.op("putIfAbsent", 0);
      counters.bytes("putIfAbsent", body.length);
      return store.putIfAbsent(key, body);
    },
    async delete(key) {
      counters.op("delete", 0);
      return store.delete(key);
    },
    list(prefix) {
      counters.op("list", 0);
      return store.list(prefix);
    },
  };
}

module.exports = { createCounters, instrumentClient, countStore };
