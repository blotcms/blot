// Renders blog pages in a throwaway process with extra instrumentation, to
// diagnose renders that stall or crash a production container. Started by
// scripts/render-probe/index.js inside a one-off `docker run` of the same
// image the app containers run - see that file and README.md. It mounts the
// real `blog` router on 127.0.0.1, so lookups, template loading, retrieval
// and the process-local LRU caches behave exactly as they do in yellow (and
// start cold, like a freshly restarted container).
//
//   node probe.js <url...> [--concurrency N] [--repeat N] [--urls file]
//   node probe.js --replay <access log> --from HH:MM:SS --to HH:MM:SS
//   node probe.js --stats <url|handle|domain>
//
// Writes samples.ndjson, phases.ndjson, requests.ndjson (appended as it goes,
// so they survive an out-of-memory crash) and summary.json to --out.

const fs = require("fs");
const path = require("path");
const http = require("http");
const readline = require("readline");
const v8 = require("v8");
const { AsyncLocalStorage } = require("async_hooks");
const {
  monitorEventLoopDelay,
  PerformanceObserver,
  performance,
} = require("perf_hooks");

const MAX_CONCURRENCY = 8;
const SAMPLE_INTERVAL_MS = 100;

const args = parseArgs(process.argv.slice(2));
const OUT = args.out || "/out";
const verbose = !!args.verbose;
const als = new AsyncLocalStorage();
const t0 = performance.now();

fs.mkdirSync(OUT, { recursive: true });

function now() {
  return Math.round(performance.now() - t0);
}

function append(file, record) {
  fs.appendFileSync(path.join(OUT, file), JSON.stringify(record) + "\n");
}

// ---------------------------------------------------------------------------
// Instrumentation. Must be installed before require("blog"): the retrievers
// destructure helpers (augmentEntries, prepareCacheValue...) at load time.

const redisTotals = { commands: 0, replyBytes: 0, byCommand: {} };

function approxSize(value) {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  if (Buffer.isBuffer(value)) return value.length;
  if (Array.isArray(value)) {
    let n = 0;
    for (const item of value) n += approxSize(item);
    return n;
  }
  if (typeof value === "object") {
    let n = 0;
    for (const key of Object.keys(value)) n += key.length + approxSize(value[key]);
    return n;
  }
  return 8;
}

function instrumentRedis() {
  const client = require("models/client");
  let proto = client;
  while (proto && !Object.prototype.hasOwnProperty.call(proto, "sendCommand")) {
    proto = Object.getPrototypeOf(proto);
  }
  if (!proto) return console.warn("probe: could not find sendCommand to wrap");

  const original = proto.sendCommand;
  proto.sendCommand = async function (redisArgs, options) {
    const name = String((redisArgs && redisArgs[0]) || "?").toUpperCase();
    const start = performance.now();
    const reply = await original.call(this, redisArgs, options);
    const bytes = approxSize(reply);
    const ms = performance.now() - start;

    const entry = (redisTotals.byCommand[name] = redisTotals.byCommand[name] || {
      count: 0,
      replyBytes: 0,
      ms: 0,
    });
    entry.count++;
    entry.replyBytes += bytes;
    entry.ms += ms;
    redisTotals.commands++;
    redisTotals.replyBytes += bytes;

    const store = als.getStore();
    if (store) {
      store.redisCommands++;
      store.redisBytes += bytes;
    }
    return reply;
  };
}

function timed(name, fn) {
  return function () {
    const store = als.getStore();
    const start = performance.now();
    const heapBefore = process.memoryUsage().heapUsed;
    const finish = () => {
      const ms = Math.round(performance.now() - start);
      const heapDeltaMB = mb(process.memoryUsage().heapUsed - heapBefore);
      // Most calls are trivial; keep the file to the ones that cost something.
      if (ms < 1 && Math.abs(heapDeltaMB) < 1) return;
      append("phases.ndjson", { t: now(), req: store ? store.id : null, name, ms, heapDeltaMB });
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
}

// Replace a property of a module's exports, or the export itself when key is
// null, before anything else requires it. Older releases (--release, for
// bisecting) may not have every module, so a missing one is skipped.
function tryResolve(moduleName) {
  try {
    return require.resolve(moduleName);
  } catch (err) {
    console.warn(`probe: ${moduleName} not in this release, not instrumented`);
    return null;
  }
}

function wrapExport(moduleName, key, label) {
  const resolved = tryResolve(moduleName);
  if (!resolved) return;
  const exported = require(resolved);
  if (key === null) {
    const wrapped = timed(label, exported);
    Object.assign(wrapped, exported);
    require.cache[resolved].exports = wrapped;
  } else if (typeof exported[key] === "function") {
    exported[key] = timed(label, exported[key]);
  }
}

function instrumentRender() {
  wrapExport("blog/render/retrieve/helpers/getAllCached", null, "getAllCached");
  wrapExport("blog/render/load/augmentedEntries", "augmentEntries", "augmentEntries");
  wrapExport("blog/render/load/augmentedEntries", "shareEntries", "shareEntries");
  wrapExport("blog/lib/clone", "prepareCacheValue", "prepareCacheValue");
  wrapExport("blog/lib/clone", "cloneDeep", "cloneDeep");
  wrapExport("blog/render/load", null, "loadView");
  wrapExport("blog/render/main", null, "mustache");

  // retrieve() looks retrievers up in this dictionary per call.
  const { dictionary } = require("blog/render/retrieve");
  for (const name of Object.keys(dictionary)) {
    dictionary[name] = timed("retrieve:" + name, dictionary[name]);
  }
}

// ---------------------------------------------------------------------------
// Sampling: heap, event loop delay, GC.

const gc = { count: 0, totalMs: 0, maxMs: 0 };
const peaks = { heapUsedMB: 0, rssMB: 0, eventLoopDelayMaxMs: 0 };
let inflight = 0;
let completed = 0;

function mb(bytes) {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function startSampling() {
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();

  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gc.count++;
      gc.totalMs += entry.duration;
      gc.maxMs = Math.max(gc.maxMs, entry.duration);
      if (entry.duration > 100) {
        append("phases.ndjson", {
          t: now(),
          name: "gc",
          ms: Math.round(entry.duration),
          kind: entry.detail && entry.detail.kind,
        });
      }
    }
  }).observe({ entryTypes: ["gc"] });

  let lastPrint = 0;
  let lastRedis = 0;

  const timer = setInterval(() => {
    const mem = process.memoryUsage();
    const heap = v8.getHeapStatistics();
    const delayMax = loop.max / 1e6;
    loop.reset();

    peaks.heapUsedMB = Math.max(peaks.heapUsedMB, mb(mem.heapUsed));
    peaks.rssMB = Math.max(peaks.rssMB, mb(mem.rss));
    peaks.eventLoopDelayMaxMs = Math.max(peaks.eventLoopDelayMaxMs, delayMax);

    append("samples.ndjson", {
      t: now(),
      heapUsedMB: mb(mem.heapUsed),
      heapTotalMB: mb(mem.heapTotal),
      heapLimitMB: mb(heap.heap_size_limit),
      externalMB: mb(mem.external),
      rssMB: mb(mem.rss),
      eventLoopDelayMaxMs: Math.round(delayMax),
      inflight,
      completed,
      redisCommands: redisTotals.commands,
      gcCount: gc.count,
    });

    if (now() - lastPrint >= 1000) {
      const redisRate = redisTotals.commands - lastRedis;
      lastRedis = redisTotals.commands;
      lastPrint = now();
      console.log(
        `[${(now() / 1000).toFixed(1)}s] inflight=${inflight} done=${completed}` +
          ` heap=${mb(mem.heapUsed)}/${mb(heap.heap_size_limit)}MB rss=${mb(mem.rss)}MB` +
          ` loopDelayMax=${Math.round(delayMax)}ms redis=${redisRate}/s`
      );
    }
  }, SAMPLE_INTERVAL_MS);
  timer.unref();
}

// ---------------------------------------------------------------------------
// Server and client.

function startServer() {
  const express = require("express");
  const blog = require("blog");
  const { redisUnavailableHandler } = require("helper/redisUnavailable");

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
  const heapBefore = process.memoryUsage().heapUsed;
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
        timeout: (args.timeout || 120) * 1000,
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
      const record = {
        id,
        url,
        status,
        bytes,
        startedAt,
        ms: Math.round(performance.now() - start),
        heapDeltaMB: mb(process.memoryUsage().heapUsed - heapBefore),
      };
      append("requests.ndjson", record);
      console.log(`  ${status} ${record.ms}ms ${bytes}B ${url}`);
      resolve(record);
    }
  });
}

// ---------------------------------------------------------------------------
// Modes.

async function runUrls(port, urls) {
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
  const from = args.from;
  const to = args.to;
  if (!from || !to) throw new Error("--replay needs --from and --to (YYYY-MM-DDTHH:MM:SS, UTC)");
  const fromMs = Date.parse(from + "Z");
  const toMs = Date.parse(to + "Z");

  const requests = [];
  const lines = readline.createInterface({ input: fs.createReadStream(file) });
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
  return requests.sort((a, b) => a.at - b.at);
}

async function runReplay(port) {
  const requests = await readReplay(args.replay);
  const speed = Number(args.speed) || 1;
  const maxInflight = Number(args["max-inflight"]) || 64;
  let skipped = 0;
  console.log(`probe: replaying ${requests.length} request(s) at ${speed}x`);

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
  if (skipped) console.log(`probe: skipped ${skipped} request(s) over --max-inflight ${maxInflight}`);
  return results;
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
  };
  console.log(JSON.stringify(stats, null, 2));
  return stats;
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      out._.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split("=");
    if (inline !== undefined) out[key] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

async function main() {
  let urls = args._.slice();
  if (args.urls) {
    urls = urls.concat(
      fs.readFileSync(args.urls, "utf8").split("\n").map((s) => s.trim()).filter(Boolean)
    );
  }

  instrumentRedis();
  instrumentRender();
  startSampling();

  const summary = { args: process.argv.slice(2), release: process.env.BLOT_RELEASE_ID };
  try {
    if (args.stats) {
      summary.stats = await runStats(args.stats === true ? urls[0] : args.stats);
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

  Object.assign(summary, {
    elapsedMs: now(),
    peaks,
    gc: { ...gc, totalMs: Math.round(gc.totalMs), maxMs: Math.round(gc.maxMs) },
    redis: {
      ...redisTotals,
      byCommand: Object.fromEntries(
        Object.entries(redisTotals.byCommand).map(([name, c]) => [
          name,
          { ...c, ms: Math.round(c.ms), replyMB: mb(c.replyBytes) },
        ])
      ),
    },
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
    heapSpaces: v8.getHeapSpaceStatistics().map((space) => ({
      name: space.space_name,
      usedMB: mb(space.space_used_size),
    })),
  });

  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(
    `probe: done in ${(now() / 1000).toFixed(1)}s, peak heap ${peaks.heapUsedMB}MB,` +
      ` max loop delay ${Math.round(peaks.eventLoopDelayMaxMs)}ms,` +
      ` ${redisTotals.commands} Redis commands (${mb(redisTotals.replyBytes)}MB replies)`
  );
  process.exit();
}

main();
