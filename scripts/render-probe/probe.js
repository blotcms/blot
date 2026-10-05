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
  stats: { value: "URL|HANDLE", help: "catalog size/backlink facts, no rendering" },
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
  const fromMs = Date.parse(from + "Z");
  const toMs = Date.parse(to + "Z");
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
