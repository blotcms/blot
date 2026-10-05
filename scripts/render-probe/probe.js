// Renders blog pages in a throwaway process with extra instrumentation, to
// diagnose renders that stall or crash a production container. Started by
// scripts/render-probe/index.js (through scripts/probe/run.js) inside a
// one-off container of the same image the app containers run - see
// README.md. It mounts the real `blog` router on 127.0.0.1, so lookups,
// template loading, retrieval and the process-local LRU caches behave
// exactly as they do in yellow (and start cold, like a freshly restarted
// container).
//
//   node probe.js <url...> [--concurrency N] [--repeat N]
//   node probe.js --replay <access log> --from <time> --to <time>
//   node probe.js --stats <url|handle|domain>
//
// Writes samples.ndjson, phases.ndjson, requests.ndjson (appended as it goes,
// so they survive an out-of-memory crash) and summary.json to --out.

const fs = require("fs");
const http = require("http");
const readline = require("readline");
const zlib = require("zlib");
const { AsyncLocalStorage } = require("async_hooks");
const { performance } = require("perf_hooks");
const { parseArgs } = require("../probe/args");
const instrument = require("../probe/instrument");

const { mb, now } = instrument;

// Cold renders of a large blog are heavy on the shared, live Redis.
const MAX_CONCURRENCY = 8;
const MAX_REPLAY_SPEED = 4;

const OPTIONS = {
  concurrency: { value: "N", help: `parallel requests (default 1, max ${MAX_CONCURRENCY})` },
  repeat: { value: "N", help: "send each URL N times" },
  stats: { value: "URL|HANDLE", help: "catalog size, bytes per field, backlink facts and catalog read timings, no rendering" },
  experiment: { help: "with --stats: repeat the catalog read, other batch sizes, pipelined GETs (~35MB of reads)" },
  sweep: { help: "with --stats: catalog read at batch sizes 10/25/50/100, interleaved, 2 passes each (~42MB of reads)" },
  replay: { value: "FILE", help: "replay yellow's requests from an access log (.gz too)" },
  from: { value: "TIME", help: "replay window start, UTC (YYYY-MM-DDTHH:MM:SS)" },
  to: { value: "TIME", help: "replay window end, UTC" },
  speed: { value: "N", help: `replay speed multiplier (default 1, max ${MAX_REPLAY_SPEED})` },
  "max-inflight": {
    value: "N",
    help: `replay: skip requests while N are in flight (default and max ${MAX_CONCURRENCY})`,
  },
  upstream: { value: "HOST:PORT", help: "replay: the container's upstream (default yellow's)" },
  timeout: { value: "S", help: "per-request timeout (default 120)" },
  verbose: { help: "print each request's render steps" },
  out: { value: "DIR" },
};

let args;
let verbose;
let out;
const als = new AsyncLocalStorage();

// ---------------------------------------------------------------------------
// Instrumentation. Must be installed before require("blog"), and in order:
// most render modules destructure helpers from blog/lib/clone and
// blog/render/load/augmentedEntries when they load (getAllCached included),
// so those are wrapped first, then the modules that require them.

let redis;

function instrumentRedis() {
  redis = instrument.trackRedis({
    scope: () => als.getStore(),
    onCommand(store, name, count, bytes) {
      if (!store) return;
      store.redisCommands += count;
      store.redisBytes += bytes;
    },
  });
}

let inflight = 0;
let completed = 0;
const WRAPPED = Symbol("probe wrapped");

function timed(name, fn) {
  const wrapped = function () {
    const store = als.getStore();
    const start = performance.now();
    // A heap delta only means something if no other request ran meanwhile.
    const requestsBefore = requestCounter;
    const heapBefore = inflight <= 1 ? process.memoryUsage().heapUsed : null;
    const finish = () => {
      const ms = Math.round(performance.now() - start);
      const record = { t: now(), req: store ? store.id : null, name, ms };
      if (heapBefore !== null && inflight <= 1 && requestCounter === requestsBefore) {
        record.soleRequestHeapDeltaMB = mb(process.memoryUsage().heapUsed - heapBefore);
      }
      // Most calls are trivial; keep the file to the ones that cost something.
      if (ms < 1 && !(Math.abs(record.soleRequestHeapDeltaMB) >= 1)) return;
      out.append("phases.ndjson", record);
    };
    let result;
    try {
      result = fn.apply(this, arguments);
    } catch (err) {
      finish();
      throw err;
    }
    if (result && typeof result.then === "function") {
      return result.finally(finish);
    }
    finish();
    return result;
  };
  wrapped[WRAPPED] = true;
  return wrapped;
}

// Replace a property of a module's exports, or the export itself when key is
// null, before anything else requires it. Older releases (--release, for
// bisecting) may not have every module, so a missing one is skipped.
function tryResolve(moduleName) {
  try {
    return require.resolve(moduleName);
  } catch (err) {
    return null;
  }
}

const wrappedExports = [];

function wrapExport(moduleName, key, label) {
  const resolved = tryResolve(moduleName);
  if (!resolved) return console.warn(`probe: ${moduleName} not in this release, not instrumented`);
  const exported = require(resolved);
  if (key === null) {
    const wrapped = timed(label, exported);
    Object.assign(wrapped, exported);
    require.cache[resolved].exports = wrapped;
  } else if (typeof exported[key] === "function") {
    exported[key] = timed(label, exported[key]);
  } else {
    return console.warn(`probe: ${moduleName} has no ${key}, not instrumented`);
  }
  wrappedExports.push({ moduleName, key });
}

function instrumentRender() {
  // A blog module loaded before this point may already hold an unwrapped
  // helper, so its calls would go untimed.
  const early = Object.keys(require.cache).filter((file) => file.includes("/app/blog/"));
  if (early.length) console.warn("probe: blog modules loaded before instrumenting:", early);

  wrapExport("blog/lib/clone", "prepareCacheValue", "prepareCacheValue");
  wrapExport("blog/lib/clone", "cloneDeep", "cloneDeep");
  wrapExport("blog/render/load/augmentedEntries", "augmentEntries", "augmentEntries");
  wrapExport("blog/render/load/augmentedEntries", "shareEntries", "shareEntries");
  wrapExport("blog/render/retrieve/helpers/getAllCached", null, "getAllCached");
  wrapExport("blog/render/load", null, "loadView");
  wrapExport("blog/render/main", null, "mustache");

  // retrieve() looks retrievers up in this dictionary per call.
  const { dictionary } = require("blog/render/retrieve");
  for (const name of Object.keys(dictionary)) {
    dictionary[name] = timed("retrieve:" + name, dictionary[name]);
  }
}

// After require("blog"): warn if anything replaced a wrapped export.
function checkInstrumentation() {
  for (const { moduleName, key } of wrappedExports) {
    const exported = require(moduleName);
    const value = key === null ? exported : exported[key];
    if (!value || !value[WRAPPED]) {
      console.warn(`probe: ${moduleName}${key ? "." + key : ""} is no longer instrumented`);
    }
  }
}

// ---------------------------------------------------------------------------
// Server and client.

const stores = new Map();

function startServer() {
  const express = require("express");
  const blog = require("blog");
  const { redisUnavailableHandler } = require("helper/redisUnavailable");
  checkInstrumentation();

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  let nextId = 0;
  app.use((req, res, next) => {
    const store = {
      id: req.get("x-request-id") || String(++nextId),
      redisCommands: 0,
      redisBytes: 0,
    };
    stores.set(store.id, store);
    req.probe = store;
    req.log = verbose
      ? (...line) => console.log(store.id, (now() / 1000).toFixed(3), ...line)
      : () => {};
    als.run(store, next);
  });
  app.use(blog);
  app.use(redisUnavailableHandler);

  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

let requestCounter = 0;

function request(port, url) {
  const parsed = new URL(url);
  const id = "probe-" + ++requestCounter;
  const start = performance.now();
  const startedAt = now();
  inflight++;

  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: parsed.pathname + parsed.search,
        headers: {
          host: parsed.host,
          "x-forwarded-proto": parsed.protocol.replace(":", ""),
          "x-request-id": id,
        },
        timeout: (Number(args.timeout) || 120) * 1000,
      },
      (res) => {
        let bytes = 0;
        res.on("data", (chunk) => (bytes += chunk.length));
        res.on("end", () => done(res.statusCode, bytes));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => done("error: " + err.message, 0));

    function done(status, bytes) {
      inflight--;
      completed++;
      const store = stores.get(id);
      stores.delete(id);
      const record = {
        id,
        url,
        status,
        bytes,
        startedAt,
        ms: Math.round(performance.now() - start),
        redisCommands: store ? store.redisCommands : null,
        redisReplyMB: store ? mb(store.redisBytes) : null,
      };
      out.append("requests.ndjson", record);
      console.log(`  ${status} ${record.ms}ms ${bytes}B ${url}`);
      resolve(record);
    }
  });
}

// ---------------------------------------------------------------------------
// Modes.

async function runUrls(port, urls) {
  if (!urls.length) throw new Error("Pass at least one URL (or --replay, or --stats)");
  const concurrency = Math.min(Number(args.concurrency) || 1, MAX_CONCURRENCY);
  const repeat = Number(args.repeat) || 1;
  const queue = [];
  for (let i = 0; i < repeat; i++) queue.push(...urls);

  console.log(
    `probe: ${queue.length} request(s), concurrency ${concurrency}` +
      (Number(args.concurrency) > MAX_CONCURRENCY ? ` (capped from ${args.concurrency})` : "")
  );

  const results = [];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (queue.length) results.push(await request(port, queue.shift()));
    })
  );
  return results;
}

// Access log lines look like:
// [01/Oct/2026:10:03:27 +0000] <id> <status> <secs> <bytes> <url>  cache=... up=127.0.0.1:8090 ...
const ACCESS_LINE = /^\[(\d\d)\/(\w{3})\/(\d{4}):(\d\d:\d\d:\d\d) [+-]\d{4}\] \S+ \S+ (\S+) \S+ (https?:\/\/\S+)/;
const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";

async function readReplay(file) {
  const upstream = args.upstream || "127.0.0.1:8090";
  const { from, to } = args;
  if (!from || !to) throw new Error("--replay needs --from and --to (YYYY-MM-DDTHH:MM:SS, UTC)");
  const fromMs = Date.parse(from.replace(/Z$/, "") + "Z");
  const toMs = Date.parse(to.replace(/Z$/, "") + "Z");
  if (isNaN(fromMs) || isNaN(toMs)) throw new Error("--from/--to must look like 2026-10-01T10:03:30");

  // Rotated logs are gzipped.
  let input = fs.createReadStream(file);
  if (file.endsWith(".gz")) input = input.pipe(zlib.createGunzip());

  const requests = [];
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes("up=" + upstream)) continue;
    const match = ACCESS_LINE.exec(line);
    if (!match) continue;
    const [, day, mon, year, time, secs, url] = match;
    const month = String(MONTHS.indexOf(mon) / 3 + 1).padStart(2, "0");
    const finishedMs = Date.parse(`${year}-${month}-${day}T${time}Z`);
    // Lines are written when a request finishes; replay at its start time.
    const startMs = finishedMs - Math.round(parseFloat(secs) * 1000);
    if (startMs < fromMs || startMs > toMs) continue;
    requests.push({ at: startMs - fromMs, url });
  }

  if (!requests.length) {
    throw new Error(
      `No requests to ${upstream} started between ${from} and ${to} in ${file}` +
        " (times are UTC; does the file cover that window?)"
    );
  }
  return requests.sort((a, b) => a.at - b.at);
}

// Capped like --concurrency: the point is to reproduce yellow's load on
// this process, but it all lands on the live Redis too.
async function runReplay(port) {
  const requests = await readReplay(args.replay);
  const speed = Math.min(Number(args.speed) || 1, MAX_REPLAY_SPEED);
  const maxInflight = Math.min(Number(args["max-inflight"]) || MAX_CONCURRENCY, MAX_CONCURRENCY);
  let skipped = 0;
  console.log(
    `probe: replaying ${requests.length} request(s) at ${speed}x, at most ${maxInflight} in flight`
  );

  const start = performance.now();
  const pending = [];
  for (const { at, url } of requests) {
    const wait = at / speed - (performance.now() - start);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (inflight >= maxInflight) {
      skipped++;
      continue;
    }
    pending.push(request(port, url));
  }
  const results = await Promise.all(pending);
  if (skipped) console.log(`probe: skipped ${skipped} request(s) while ${maxInflight} were in flight`);
  return results;
}

// Where the catalog's bytes are: the JSON size of each entry field, summed
// over every entry. Shows how much of the catalog a skinnier read could drop.
function fieldBreakdown(entries) {
  const { HEAVY_FIELDS } = require("blog/render/retrieve/helpers/projectEntryFields");
  const bytesByField = {};
  let total = 0;
  for (const entry of entries) {
    total += JSON.stringify(entry).length;
    for (const key of Object.keys(entry)) {
      const json = JSON.stringify(entry[key]);
      bytesByField[key] = (bytesByField[key] || 0) + (json ? json.length : 0);
    }
  }
  const fields = Object.entries(bytesByField).sort((a, b) => b[1] - a[1]);
  const heavy = fields.filter(([key]) => HEAVY_FIELDS.includes(key)).reduce((n, [, b]) => n + b, 0);
  return {
    totalMB: mb(total),
    heavyFields: HEAVY_FIELDS,
    heavyFieldsMB: mb(heavy),
    withoutHeavyFieldsMB: mb(total - heavy),
    fieldsMB: fields.slice(0, 15).map(([key, bytes]) => ({
      field: key,
      mb: mb(bytes),
      percent: Math.round((100 * bytes) / total),
    })),
  };
}

// Where the time goes when the catalog is read (what getAllCached waits on
// when it misses): round trip latency, large reply transfer, parsing, and the
// cache preparation, each timed on its own. Reads only; the same commands
// Entries.getAll sends, in the same batches.
async function catalogTimings(blog, entries) {
  const redisClient = require("models/client");
  const Entries = require("models/entries");
  const { entry: entryKey } = require("models/entry/key");
  const { cloneDeep, prepareCacheValue } = require("blog/lib/clone");
  const { getAll } = require("blog/lib/models");

  const elapsed = (start) => Math.round((performance.now() - start) * 10) / 10;
  const timed = async (fn) => {
    const start = performance.now();
    const value = await fn();
    return [value, elapsed(start)];
  };
  const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
  const spread = (list) => ({ min: Math.min(...list), median: median(list), max: Math.max(...list) });
  const repeat = async (n, fn) => {
    const times = [];
    for (let i = 0; i < n; i++) times.push((await timed(fn))[1]);
    return times;
  };

  const timings = {};

  // Round trip floor: nothing to transfer.
  timings.pingMs = spread(await repeat(20, () => redisClient.ping()));
  timings.missingKeyGetMs = spread(
    await repeat(20, () => redisClient.get(`blog:${blog.id}:probe-missing-key`))
  );

  const [ids, idsMs] = await timed(
    () =>
      new Promise((resolve, reject) =>
        Entries.getListIDs(blog.id, "entries", {}, (err, list) => (err ? reject(err) : resolve(list)))
      )
  );
  timings.listIDsMs = idsMs;

  // One large value: round trip plus transfer of a single big reply.
  let largest;
  let largestBytes = -1;
  for (const entry of entries) {
    const size = JSON.stringify(entry).length;
    if (size > largestBytes) [largest, largestBytes] = [entry, size];
  }
  if (largest) {
    const key = entryKey(blog.id, largest.id || largest.path);
    let bytes = 0;
    const times = await repeat(5, async () => {
      const value = await redisClient.get(key);
      bytes = value ? value.length : 0;
    });
    timings.largestEntryGet = { bytes, ms: spread(times) };
  }

  // The catalog read itself, in Entry.get's batches of 100.
  const BATCH = 100;
  const batches = [];
  const parsed = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    if (i > 0) await new Promise(setImmediate);
    const keys = ids.slice(i, i + BATCH).map((id) => entryKey(blog.id, id));
    const [values, mgetMs] = await timed(() => redisClient.mGet(keys));
    const bytes = values.reduce((n, value) => n + (value ? value.length : 0), 0);
    const [, parseMs] = await timed(async () => {
      for (const value of values) if (value) parsed.push(JSON.parse(value));
    });
    batches.push({ keys: keys.length, bytes, mgetMs, parseMs });
  }
  const sum = (key) => Math.round(batches.reduce((n, batch) => n + batch[key], 0) * 10) / 10;
  timings.batches = batches.map((batch) => ({ ...batch, bytes: undefined, KB: Math.round(batch.bytes / 1024) }));
  timings.mgetTotalMs = sum("mgetMs");
  timings.parseTotalMs = sum("parseMs");
  timings.transferMBPerSecond = Math.round((sum("bytes") / 1024 / 1024 / (sum("mgetMs") / 1000)) * 10) / 10;

  // What getAllCached does around the read.
  timings.getAllMs = (await timed(() => getAll(blog.id)))[1];
  timings.getAllAgainMs = (await timed(() => getAll(blog.id)))[1];
  timings.prepareCacheValueMs = (await timed(async () => prepareCacheValue(entries, { preserveEntryInstances: true })))[1];
  timings.cloneDeepMs = (await timed(async () => cloneDeep(entries, { preserveEntryInstances: true })))[1];

  if (args.experiment) timings.experiment = await catalogExperiment(blog, ids, redisClient);
  if (args.sweep) timings.sweep = await catalogSweep(blog, ids, redisClient);

  return timings;
}

// The catalog read shows ~300ms stalls on some MGET batches regardless of
// their size. These repeat it, to tell whether the same batches stall every
// time (the keys) or different ones (Redis or the network), and compare batch
// sizes and pipelined GETs against MGET. Reads only; about 5MB per pass.
async function catalogExperiment(blog, ids, redisClient) {
  const { entry: entryKey } = require("models/entry/key");
  const round1 = (n) => Math.round(n * 10) / 10;
  const keys = ids.map((id) => entryKey(blog.id, id));
  const t0 = performance.now();

  async function pass(size, read) {
    const batches = [];
    const start = performance.now();
    for (let i = 0; i < keys.length; i += size) {
      if (i > 0) await new Promise(setImmediate);
      const slice = keys.slice(i, i + size);
      const at = performance.now();
      const values = await read(slice);
      batches.push({
        ms: round1(performance.now() - at),
        KB: Math.round(values.reduce((n, value) => n + (value ? value.length : 0), 0) / 1024),
      });
    }
    return { totalMs: round1(performance.now() - start), batches };
  }

  const mget = (slice) => redisClient.mGet(slice);
  // Commands issued in the same tick are pipelined by node-redis.
  const gets = (slice) => Promise.all(slice.map((key) => redisClient.get(key)));

  const experiment = { startedAtMs: round1(t0), mget100: [] };
  for (let i = 0; i < 3; i++) {
    const result = await pass(100, mget);
    experiment.mget100.push({
      totalMs: result.totalMs,
      batchMs: result.batches.map((batch) => batch.ms),
      batchKB: i === 0 ? result.batches.map((batch) => batch.KB) : undefined,
    });
  }
  for (const size of [25, 400]) {
    const result = await pass(size, mget);
    experiment[`mget${size}`] = { totalMs: result.totalMs, batchMs: result.batches.map((batch) => batch.ms) };
  }
  const pipelined = await pass(100, gets);
  experiment.pipelinedGet100 = { totalMs: pipelined.totalMs, batchMs: pipelined.batches.map((batch) => batch.ms) };

  // Whether the same batch index is slow in every pass.
  const slow = (ms) => ms > 100;
  experiment.slowBatchIndexesPerPass = experiment.mget100.map((p) =>
    p.batchMs.map((ms, i) => (slow(ms) ? i : null)).filter((i) => i !== null)
  );
  return experiment;
}

// Batch size against stalls: the whole catalog read at each size, the sizes
// interleaved pass by pass so a slow minute on Redis or the network hits all of
// them alike. A batch over 100ms counts as a stall (a healthy one is 2-20ms).
async function catalogSweep(blog, ids, redisClient, { sizes = [10, 25, 50, 100], passes = 2 } = {}) {
  const { entry: entryKey } = require("models/entry/key");
  const round1 = (n) => Math.round(n * 10) / 10;
  const keys = ids.map((id) => entryKey(blog.id, id));
  const results = Object.fromEntries(sizes.map((size) => [size, []]));

  for (let pass = 0; pass < passes; pass++) {
    // Rotate the order each pass, so no size always runs first.
    const order = sizes.map((_, i) => sizes[(i + pass) % sizes.length]);
    for (const size of order) {
      const batchMs = [];
      let maxKB = 0;
      const start = performance.now();
      for (let i = 0; i < keys.length; i += size) {
        if (i > 0) await new Promise(setImmediate);
        const at = performance.now();
        const values = await redisClient.mGet(keys.slice(i, i + size));
        batchMs.push(round1(performance.now() - at));
        const bytes = values.reduce((n, value) => n + (value ? value.length : 0), 0);
        maxKB = Math.max(maxKB, Math.round(bytes / 1024));
      }
      results[size].push({
        totalMs: round1(performance.now() - start),
        stalls: batchMs.filter((ms) => ms > 100).length,
        roundTrips: batchMs.length,
        slowestBatchMs: Math.max(...batchMs),
        maxBatchKB: maxKB,
      });
    }
  }
  return results;
}

// What Redis itself reports: its own per-command timings (cumulative over its
// uptime, so these include the app's traffic), persistence/fork state and
// recent slow commands. Read-only. Slow log entries keep the command name and
// duration, not the arguments. Any of these may be disabled; each says so.
async function redisDiagnostics() {
  const redisClient = require("models/client");
  const out = {};
  const attempt = async (name, fn) => {
    try {
      out[name] = await fn();
    } catch (e) {
      out[name] = { error: String(e && e.message) };
    }
  };

  const wanted = {
    server: /^(redis_version|uptime_in_seconds|io_threads_active|process_id):/,
    clients: /^(connected_clients|blocked_clients|tracking_clients|clients_in_timeout_table|maxclients):/,
    memory: /^(used_memory_human|used_memory_rss_human|maxmemory_human|maxmemory_policy|mem_fragmentation_ratio|allocator_frag_ratio):/,
    persistence:
      /^(loading|rdb_changes_since_last_save|rdb_bgsave_in_progress|rdb_last_bgsave_status|rdb_last_bgsave_time_sec|aof_enabled|aof_rewrite_in_progress|aof_last_bgrewrite_status|aof_delayed_fsync|latest_fork_usec):/,
    stats:
      /^(instantaneous_ops_per_sec|instantaneous_input_kbps|instantaneous_output_kbps|total_net_output_bytes|rejected_connections|expired_keys|evicted_keys|keyspace_hits|keyspace_misses|total_reads_processed|io_threaded_reads_processed):/,
    commandstats: /^cmdstat_(mget|get|zrange|ping|hgetall|zcard):/,
    latencystats: /^latency_percentiles_usec_(mget|get|zrange):/,
  };
  for (const [section, pattern] of Object.entries(wanted)) {
    await attempt(section, async () => {
      const text = await redisClient.info(section);
      return text.split(/\r?\n/).filter((line) => pattern.test(line));
    });
  }

  await attempt("slowlogLength", () => redisClient.sendCommand(["SLOWLOG", "LEN"]));
  await attempt("slowlog", async () => {
    const rows = await redisClient.sendCommand(["SLOWLOG", "GET", "25"]);
    return rows.map((row) => ({
      id: Number(row[0]),
      at: new Date(Number(row[1]) * 1000).toISOString(),
      durationUs: Number(row[2]),
      command: String(row[3][0]).toUpperCase(),
      args: row[3].length - 1,
    }));
  });
  await attempt("latencyLatest", () => redisClient.sendCommand(["LATENCY", "LATEST"]));
  return out;
}

// Catalog facts, no rendering: is this blog unusual in size or backlinks?
async function runStats(identifier) {
  const { getBlog, getAll } = require("blog/lib/models");
  let lookup = { handle: identifier };
  if (/^https?:\/\//.test(identifier)) lookup = { domain: new URL(identifier).hostname };
  else if (identifier.includes(".")) lookup = { domain: identifier };
  else if (identifier.startsWith("blog_")) lookup = { id: identifier };

  let blog = await getBlog(lookup);
  if (!blog && lookup.domain && lookup.domain.startsWith("www.")) {
    blog = await getBlog({ domain: lookup.domain.slice(4) });
  }
  if (!blog) throw new Error("No blog found for " + identifier);

  const entries = await getAll(blog.id);
  const sizeByUrl = new Map();
  const rows = entries.map((entry) => {
    const bytes = JSON.stringify(entry).length;
    if (entry.url) sizeByUrl.set(entry.url, bytes);
    return {
      path: entry.path,
      url: entry.url,
      bytes,
      htmlBytes: (entry.html || "").length,
      backlinks: (entry.backlinks || []).length,
      backlinkUrls: entry.backlinks || [],
    };
  });

  // augment() replaces each backlink URL with the full linked entry, and the
  // augmented catalog is what allEntries/archives cache - so roughly this is
  // what one augmented copy weighs.
  let backlinkBytes = 0;
  for (const row of rows) {
    row.backlinkBytes = row.backlinkUrls.reduce((n, url) => n + (sizeByUrl.get(url) || 0), 0);
    backlinkBytes += row.backlinkBytes;
    delete row.backlinkUrls;
  }

  const top = (key) =>
    [...rows].sort((a, b) => b[key] - a[key]).slice(0, 10).map((row) => ({
      path: row.path,
      [key]: row[key],
    }));

  const stats = {
    blogID: blog.id,
    handle: blog.handle,
    domain: blog.domain,
    cacheID: blog.cacheID,
    template: blog.template,
    entries: rows.length,
    catalogMB: mb(rows.reduce((n, row) => n + row.bytes, 0)),
    htmlMB: mb(rows.reduce((n, row) => n + row.htmlBytes, 0)),
    backlinks: rows.reduce((n, row) => n + row.backlinks, 0),
    approxAugmentedBacklinksMB: mb(backlinkBytes),
    largestEntries: top("bytes"),
    mostBacklinks: top("backlinks"),
    heaviestBacklinks: top("backlinkBytes"),
    fieldBreakdown: fieldBreakdown(entries),
    timings: await catalogTimings(blog, entries),
    redisDiagnostics: await redisDiagnostics(),
  };
  console.log(JSON.stringify(stats, null, 2));
  return stats;
}

// ---------------------------------------------------------------------------

async function main() {
  const parsed = parseArgs(process.argv.slice(2), OPTIONS);
  args = parsed.options;
  verbose = !!args.verbose;
  out = instrument.output(args.out || "/out");
  const urls = parsed.rest;

  instrumentRedis();
  instrumentRender();
  const sampler = instrument.startSampler(out, {
    extra: () => ({ inflight, completed, redisCommands: redis.totals.commands }),
    print: (() => {
      let lastRedis = 0;
      return (sample) => {
        const redisRate = sample.redisCommands - lastRedis;
        lastRedis = sample.redisCommands;
        console.log(
          `[${(sample.t / 1000).toFixed(1)}s] inflight=${inflight} done=${completed}` +
            ` heap=${sample.heapUsedMB}/${sample.heapLimitMB}MB rss=${sample.rssMB}MB` +
            ` loopDelayMax=${sample.eventLoopDelayMaxMs}ms redis=${redisRate}/s`
        );
      };
    })(),
    onGC(ms, kind) {
      if (ms > 100) out.append("phases.ndjson", { t: now(), name: "gc", ms: Math.round(ms), kind });
    },
  });

  const summary = { args: process.argv.slice(2), release: process.env.BLOT_RELEASE_ID };
  try {
    if (args.stats) {
      summary.stats = await runStats(args.stats);
    } else {
      const port = await startServer();
      const results = args.replay ? await runReplay(port) : await runUrls(port, urls);
      summary.requests = results.length;
      summary.slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 10);
    }
  } catch (err) {
    summary.error = err.stack || String(err);
    console.error(err);
    process.exitCode = 1;
  }

  sampler.stop();
  const totals = sampler.summary();
  Object.assign(summary, totals, {
    redis: redis.summary(),
    caches: [
      "blog/render/full-view-cache",
      "blog/render/main",
      "blog/render/retrieve/helpers/getAllCached",
      "blog/render/retrieve/all_entries",
      "blog/render/retrieve/archives",
      "blog/render/retrieve/posts",
      "blog/render/retrieve/tagged",
    ]
      .filter((name) => tryResolve(name) && require(name)._stats)
      .map((name) => require(name)._stats()),
  });

  out.writeJSON("summary.json", summary);
  console.log(
    `probe: done in ${(totals.elapsedMs / 1000).toFixed(1)}s, peak heap ${totals.peaks.heapUsedMB}MB,` +
      ` max loop delay ${totals.peaks.eventLoopDelayMaxMs}ms,` +
      ` ${redis.totals.commands} Redis commands (${mb(redis.totals.replyBytes)}MB replies)`
  );
  process.exit();
}

// The wrapper requires this file for OPTIONS, to check arguments locally.
if (require.main === module) main();

module.exports = { OPTIONS };
