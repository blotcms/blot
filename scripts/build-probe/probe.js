// Rebuilds one or more posts in a standalone process while measuring memory,
// so a heap spike can be pinned to a specific post and phase without touching
// the live app containers. Started by scripts/build-probe/index.js (through
// scripts/probe/run.js) inside a one-off container of the same image the app
// containers run - see README.md. It also runs on its own:
//
//   node --expose-gc scripts/build-probe/probe.js [options] <target>...
//
// A target is a post URL (https://example.com/some-post) or
// <blog>:<path>, where <blog> is a blog ID, handle or domain
// (e.g. "example.com:/Posts/2026-10 Index.md").
//
// Each phase's result is appended to phases.ndjson in --out as it ends, so
// it survives an out-of-memory crash; summary.json is written on a clean
// exit. Exits nonzero if any phase failed.

const path = require("path");
const v8 = require("v8");
const { parseArgs } = require("../probe/args");
const instrument = require("../probe/instrument");

const { mb } = instrument;

const OPTIONS = {
  mode: {
    value: "build|sync",
    help: "build (default): only build each post, saving nothing to its entry;" +
      " sync: re-save it for real (see README.md for the side effects)",
  },
  repeat: { value: "N", help: "process the targets N times (default 1)" },
  "snapshot-at": {
    value: "MB",
    help: "write one heap snapshot when the heap first passes MB (build mode only)",
  },
  settle: {
    value: "S",
    help: "sync mode: keep measuring S seconds after each sync (default 5)",
  },
  out: { value: "DIR" },
};

const DEFAULT_SETTLE_SECONDS = 5;

// Only the shape of a target, so it can be checked without the app. A URL
// is checked for first: "https://example.com/post" would otherwise read as
// blog "https", path "//example.com/post".
function parseTarget(target) {
  if (/^https?:\/\//i.test(target)) return { url: target };
  const blogAndPath = /^([^/:]+):(\/(?!\/).*)$/.exec(target);
  if (blogAndPath) return { blog: blogAndPath[1], path: blogAndPath[2] };
  return { url: "https://" + target };
}

// Validates parsed OPTIONS, for the wrapper (locally) and the probe alike.
function checkOptions(args) {
  const mode = args.mode || "build";
  if (!["build", "sync"].includes(mode)) throw new Error("--mode must be build or sync");

  const repeat = args.repeat === undefined ? 1 : Number(args.repeat);
  if (!(Number.isInteger(repeat) && repeat >= 1)) {
    throw new Error("--repeat must be a positive integer");
  }

  const settle = args.settle === undefined ? DEFAULT_SETTLE_SECONDS : Number(args.settle);
  if (!(args.settle !== "" && Number.isFinite(settle) && settle >= 0)) {
    throw new Error("--settle must be a number of seconds");
  }

  const snapshotAt = args["snapshot-at"] === undefined ? 0 : Number(args["snapshot-at"]);
  if (args["snapshot-at"] !== undefined && !(Number.isInteger(snapshotAt) && snapshotAt > 0)) {
    throw new Error("--snapshot-at must be a positive whole number of MB");
  }

  // A sync holds the blog's lock in Redis with a 10s TTL, kept alive by a 3s
  // heartbeat (app/sync/index.js). Writing a heap snapshot blocks the event
  // loop for longer than that on a big heap, so the lock would expire and a
  // real sync could take it while this one carries on writing.
  if (mode === "sync" && snapshotAt) {
    throw new Error("--snapshot-at can't be used with --mode sync: the snapshot would outlast the sync lock");
  }

  return { mode, repeat, settle, snapshotAt };
}

let options;
let out;
let phases;
let snapshotTaken = false;
let Blog, Entry, sync, build, folderPostSourceFolder, config;
let redis, redisAtStart;

// Steps inside a build, so a phase's heap peak can be pinned to the plugin
// or lookup that was running: each plugin's prerender/render, the wikilink
// lookups and the model reads they make. Keyed by step label, reset per
// phase. A step's peak is the highest heap seen while it was running, by the
// phase sampler (between event loop turns) or at its start and end; steps
// that overlap (wikilinks resolves its links concurrently) share peaks.
let steps = new Map();
const activeSteps = new Map();

function stepStats(label) {
  if (!steps.has(label)) {
    steps.set(label, { calls: 0, ms: 0, heapPeak: 0, maxConcurrent: 0, items: 0, itemBytes: 0 });
  }
  return steps.get(label);
}

function noteHeap(heapUsed) {
  for (const label of activeSteps.keys()) {
    const stats = stepStats(label);
    stats.heapPeak = Math.max(stats.heapPeak, heapUsed);
  }
}

// Wraps fn(...args, callback) so each call is counted as a step. measure, if
// given, is passed the callback's arguments and returns { items, bytes } to
// record what the step produced (e.g. entries loaded and their size).
function stepped(label, fn, callbackIndex, measure) {
  return function (...args) {
    const index = callbackIndex === undefined ? args.length - 1 : callbackIndex;
    const callback = args[index];
    if (typeof callback !== "function" || !phases.current()) return fn.apply(this, args);

    const stats = stepStats(label);
    stats.calls++;
    activeSteps.set(label, (activeSteps.get(label) || 0) + 1);
    stats.maxConcurrent = Math.max(stats.maxConcurrent, activeSteps.get(label));
    noteHeap(process.memoryUsage().heapUsed);
    const started = instrument.now();
    let finished = false;

    args[index] = function (...results) {
      if (!finished) {
        finished = true;
        noteHeap(process.memoryUsage().heapUsed);
        stats.ms += instrument.now() - started;
        const left = activeSteps.get(label) - 1;
        if (left) activeSteps.set(label, left);
        else activeSteps.delete(label);
        if (measure) {
          try {
            const { items = 0, bytes = 0 } = measure(results) || {};
            stats.items += items;
            stats.itemBytes += bytes;
          } catch (err) {}
        }
      }
      return callback.apply(this, results);
    };
    return fn.apply(this, args);
  };
}

// Replaces a module's export (or one of its properties) with a stepped
// version. Done before the app is required, so modules that capture the
// function at load time (wikilinks' lookups) get the wrapped one.
function wrapModule(moduleName, key, label, callbackIndex, measure) {
  const resolved = require.resolve(moduleName);
  const exported = require(moduleName);
  if (key) {
    exported[key] = stepped(label, exported[key], callbackIndex, measure);
  } else {
    require.cache[resolved].exports = Object.assign(
      stepped(label, exported, callbackIndex, measure),
      exported
    );
  }
}

function countEntries(value) {
  if (!value) return 0;
  if (Array.isArray(value)) return value.length;
  return Object.values(value).reduce((n, list) => n + (Array.isArray(list) ? list.length : 0), 0);
}

function instrumentBuild() {
  // Lookups the wikilinks plugin tries in turn for each [[link]]. byTitle
  // reads the blog's entry and page lists in full.
  for (const lookup of ["byPath", "byFilename", "byURL", "byTitle", "byHeadingAnchor"]) {
    wrapModule(`build/plugins/wikilinks/${lookup}`, null, `wikilinks.${lookup}`);
  }

  // Loaded lazily by the lookups above (circular with build), so wrapping
  // the property they read at call time is enough. entries.get calls back
  // (err, { entries: [...], pages: [...] }); Entry.get calls back (entry).
  wrapModule("models/entries", "get", "models/entries.get", undefined, ([, response]) => ({
    items: countEntries(response),
    bytes: instrument.approxSize(response),
  }));
  wrapModule("models/entry", "get", "models/entry.get", undefined, ([entry]) => ({
    items: countEntries(entry && [].concat(entry)),
    bytes: instrument.approxSize(entry),
  }));

  // The plugins list holds these same objects and reads render/prerender
  // at call time.
  const pluginsDir = path.dirname(require.resolve("build/plugins"));
  for (const name of require("fs").readdirSync(pluginsDir)) {
    if (name.includes(".")) continue;
    let plugin;
    try {
      plugin = require(`build/plugins/${name}`);
    } catch (err) {
      continue;
    }
    if (!plugin || typeof plugin !== "object") continue;
    if (typeof plugin.render === "function") {
      plugin.render = stepped(`plugin.${name}.render`, plugin.render, 1);
    }
    if (typeof plugin.prerender === "function") {
      plugin.prerender = stepped(`plugin.${name}.prerender`, plugin.prerender, 1);
    }
  }
}

function stepSummary() {
  return Object.fromEntries(
    [...steps.entries()]
      .sort((a, b) => b[1].heapPeak - a[1].heapPeak)
      .map(([label, s]) => [
        label,
        {
          calls: s.calls,
          ms: Math.round(s.ms),
          heapPeakMB: mb(s.heapPeak),
          maxConcurrent: s.maxConcurrent,
          ...(s.items || s.itemBytes ? { items: s.items, itemMB: mb(s.itemBytes) } : {}),
        },
      ])
  );
}

function onSample(usage, label) {
  noteHeap(usage.heapUsed);
  if (!options.snapshotAt || snapshotTaken || usage.heapUsed <= options.snapshotAt * 1024 * 1024) {
    return;
  }
  // Checked between event loop turns, so it can't fire inside one long
  // synchronous allocation; the wrapper's --heap-snapshot (near the heap
  // limit) and --heap-prof cover that case.
  snapshotTaken = true;
  console.log(
    `[probe] heapUsed ${mb(usage.heapUsed)}MB > ${options.snapshotAt}MB during ` +
      `${label || "between phases"}, writing snapshot...`
  );
  const file = v8.writeHeapSnapshot(path.join(out.dir, `threshold-${Date.now()}.heapsnapshot`));
  console.log(`[probe] wrote ${file}`);
}

function startPhase(label) {
  steps = new Map();
  activeSteps.clear();
  if (redis) redisAtStart = JSON.parse(JSON.stringify(redis.totals));
  phases.start(label);
}

function redisDelta() {
  if (!redis || !redisAtStart) return undefined;
  const before = redisAtStart.byCommand;
  const byCommand = {};
  for (const [name, c] of Object.entries(redis.totals.byCommand)) {
    const b = before[name] || { count: 0, replyBytes: 0, ms: 0 };
    if (c.count === b.count) continue;
    byCommand[name] = { count: c.count - b.count, replyMB: mb(c.replyBytes - b.replyBytes) };
  }
  return {
    commands: redis.totals.commands - redisAtStart.commands,
    replyMB: mb(redis.totals.replyBytes - redisAtStart.replyBytes),
    byCommand,
  };
}

function endPhase(extra) {
  const result = phases.end({ steps: stepSummary(), redis: redisDelta(), ...extra });
  const top = Object.entries(result.steps || {}).slice(0, 6);
  for (const [label, s] of top) {
    console.log(
      `[probe]   ${label}: calls ${s.calls} (max ${s.maxConcurrent} at once) ${s.ms}ms ` +
        `heapPeak ${s.heapPeakMB}MB` + (s.items !== undefined ? ` loaded ${s.items} (${s.itemMB}MB)` : "")
    );
  }
  if (result.redis) {
    console.log(`[probe]   redis: ${result.redis.commands} commands, ${result.redis.replyMB}MB replies`);
  }
  console.log(
    `[probe] ${result.label}: ${result.ms}ms heap ${result.heapBeforeMB}→peak ${result.heapPeakMB}MB ` +
      `(+${result.heapGrowthMB}, retained ${result.heapRetainedMB ?? "n/a"}) ` +
      `rss ${result.rssPeakMB}MB loopDelay ${result.maxLoopDelayMs}ms gc ${result.gcCount}/${result.gcMs}ms` +
      (result.error ? ` ERROR ${result.error}` : "")
  );
  return result;
}

// Mirrors the live entry route's URL shaping (app/blog/routes/entry.js)
// before Entry.getByUrl: trailing slash removed, leading slash added,
// lowercased. getByUrl does its own decoding.
function normalizeEntryUrlPath(urlPath) {
  let url = urlPath;
  if (url.slice(-1) === "/") url = url.slice(0, -1);
  if (url[0] !== "/") url = "/" + url;
  return url.toLowerCase();
}

function errorMessage(err) {
  return err ? err.message || String(err) : undefined;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2), OPTIONS);
  options = checkOptions(parsed.options);
  const targets = parsed.rest;
  if (!targets.length) throw new Error("Pass at least one post URL or <blog>:<path>");

  out = instrument.output(parsed.options.out || "/out");
  phases = instrument.measurePhases(out, { onSample });
  if (!global.gc) console.log("[probe] run with --expose-gc for retained-memory figures");

  redis = instrument.trackRedis();
  instrumentBuild();

  // Loaded here rather than at the top, so the wrapper can require this
  // file for OPTIONS and checkOptions without the app.
  Blog = require("models/blog");
  Entry = require("models/entry");
  sync = require("sync");
  build = require("build");
  folderPostSourceFolder = require("sync/update/folderPostSourceFolder");
  config = require("config");

  const summary = {
    args: process.argv.slice(2),
    release: process.env.BLOT_RELEASE_ID,
    options,
    targets,
  };

  try {
    const byBlog = await resolveTargets(targets);

    for (let pass = 1; pass <= options.repeat; pass++) {
      for (const { blog, paths } of byBlog.values()) {
        const tag = `${blog.handle} pass ${pass}`;
        if (options.mode === "build") {
          for (const entryPath of paths) await buildOnly(blog, entryPath, tag);
        } else {
          await syncAndUpdate(blog, paths, tag);
        }
      }
    }
  } catch (err) {
    summary.error = err.stack || String(err);
    console.error("[probe] failed:", err);
  }

  if (options.mode === "sync") await drainPurges();

  phases.stop();
  out.writeJSON("summary.json", {
    ...summary,
    elapsedMs: instrument.now(),
    results: phases.results,
    heapSpaces: instrument.heapSpaces(),
  });

  // --heap-prof and --cpu-prof write their profiles on exit, so leave via
  // process.exit rather than a crash; open connections would otherwise keep
  // the process alive.
  process.exit(summary.error || phases.results.some((result) => result.error) ? 1 : 0);
}

function buildOnly(blog, entryPath, tag) {
  return new Promise((resolve) => {
    startPhase(`${tag} build ${entryPath}`);
    build(blog, entryPath, function (err, entry) {
      // Ended first, so stringifying entry for its JSON size below isn't
      // charged to the phase's measured heap peak.
      const result = endPhase({ error: errorMessage(err) });
      if (entry) {
        result.htmlKB = entry.html ? instrument.round(entry.html.length / 1024) : undefined;
        result.entryJSONKB = instrument.round(JSON.stringify(entry).length / 1024);
        console.log(
          `[probe] ${result.label}: html ${result.htmlKB ?? "n/a"}KB entry ${result.entryJSONKB}KB`
        );
      }
      resolve();
    });
  });
}

// Mirrors scripts/entry/rebuild.js: one sync per blog, every path updated
// inside it, then the sync's completion step, each measured separately.
// folder.update() never fails its callback for a build or save error; it
// logs it and passes it back as { error } instead.
function syncAndUpdate(blog, paths, tag) {
  return new Promise((resolve, reject) => {
    startPhase(`${tag} acquire lock`);
    sync(blog.id, async function (err, folder, done) {
      endPhase({ error: errorMessage(err) });
      if (err) return reject(err);

      for (const entryPath of paths) {
        startPhase(`${tag} update ${entryPath}`);
        const updateErr = await new Promise((next) =>
          folder.update(entryPath, (err, status) => next(err || (status && status.error)))
        );
        endPhase({ error: errorMessage(updateErr) });
      }

      startPhase(`${tag} finish sync`);
      done(null, function (err) {
        endPhase({ error: errorMessage(err) });
        if (err) return reject(err);
        if (!options.settle) return resolve();
        startPhase(`${tag} settle ${options.settle}s`);
        setTimeout(() => {
          endPhase();
          resolve();
        }, options.settle * 1000);
      });
    });
  });
}

// Each update and the sync's cacheID bump queue proxy cache purges without
// waiting for them (models/blog/flushCache.js), and the queue sends them at
// 3 a second. --settle usually covers that, but don't let process.exit drop
// a purge that is still queued: an empty flush resolves once the queue is
// empty. A purge a proxy rejects is recorded in Redis and retried by the
// app containers.
async function drainPurges() {
  const DRAIN_TIMEOUT_MS = 30 * 1000;
  const flushProxies = require("helper/flushProxies");
  let timer;
  try {
    await Promise.race([
      flushProxies([]),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), DRAIN_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.log(`[probe] proxy cache purges didn't all finish: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

async function resolveTargets(targets) {
  const byBlog = new Map();

  for (const target of targets) {
    const { blog, entryPath } = await resolveTarget(target);
    if (!byBlog.has(blog.id)) byBlog.set(blog.id, { blog, paths: [] });
    byBlog.get(blog.id).paths.push(entryPath);
    console.log(`[probe] ${target} → ${blog.id} ${entryPath}`);
  }

  return byBlog;
}

async function resolveTarget(target) {
  const parsed = parseTarget(target);

  if (parsed.blog) {
    const blog = await getBlog(parsed.blog);
    return { blog, entryPath: parsed.path };
  }

  const url = new URL(parsed.url);
  const blog = await getBlog(url.hostname);
  // getByUrl does its own decoding; only the source path fallback needs it.
  const entry =
    (await new Promise((done) =>
      Entry.getByUrl(blog.id, normalizeEntryUrlPath(url.pathname), done)
    )) || (await new Promise((done) => Entry.get(blog.id, decodeURIComponent(url.pathname), done)));

  if (!entry) throw new Error("No entry at " + target);

  // A folder post is stored under its plus-stripped path (/album) but is
  // only built from its "+" source folder (/album+).
  return { blog, entryPath: folderPostSourceFolder(entry) || entry.path };
}

// By ID, handle or domain. Unlike scripts/get/blog.js this doesn't mint a
// dashboard access link as a side effect.
async function getBlog(identifier) {
  const lower = identifier.toLowerCase();
  // Mirrors extractHandle in app/blog/middleware/vhosts.js: the handle is
  // the label immediately before .<config.host>, so www.<handle>.blot.im
  // resolves to <handle> rather than www.<handle>.
  const suffix = "." + config.host;
  const handle = lower.endsWith(suffix) ? lower.slice(0, -suffix.length).split(".").pop() : lower;

  for (const by of [{ id: identifier }, { handle }, { domain: lower }]) {
    const blog = await new Promise((done) => Blog.get(by, (err, blog) => done(err ? null : blog)));
    if (blog && blog.id) return blog;
  }

  throw new Error("No blog for " + identifier);
}

// The wrapper requires this file for OPTIONS, to check arguments locally.
if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { OPTIONS, checkOptions, parseTarget, normalizeEntryUrlPath };
