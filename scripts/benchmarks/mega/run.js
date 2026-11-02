#!/usr/bin/env node
// One run of the mega-site benchmark: seed the sites described in profile.js
// into an empty Redis, serve them from this process, then time the render
// paths that hurt in production. Writes one JSON result (see metrics below).
// The workflow runs it alternately against the base and head checkouts and
// compare.js turns the results into the PR comment. Run inside the dev image
// with NODE_PATH=app, against a Redis you don't mind flushing:
//
//   node --expose-gc scripts/benchmarks/mega/run.js --output result.json
//
// --scale 0.1 shrinks every site (entry counts and sizes) for a quick check.
//
// Only public behaviour is timed (HTTP requests, the event loop, the heap),
// so the same script measures code with different caches. The render cache
// counters are read when the running code still has them.
const { monitorEventLoopDelay } = require("perf_hooks");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");

const profile = require("./profile");
const content = require("./content");
const { catalogViews, VIEW_URLS } = require("./templates");

const args = parseArgs(process.argv.slice(2));
const SCALE = Number(args.scale || 1);

const config = require("config");
const Blog = require("models/blog");
const Entry = require("models/entry");
const Template = require("models/template");

const setEntry = promisify(Entry.set);
const setBlog = promisify(Blog.set);
const createTemplate = promisify(Template.create);
const setView = promisify(Template.setView);

const CACHE_STATS = [
  "blog/render/main",
  "blog/render/full-view-cache",
  "blog/render/retrieve/posts",
  "blog/render/retrieve/archives",
  "blog/render/retrieve/all_tags",
  "blog/render/retrieve/tagged",
  "blog/render/retrieve/all_entries",
  "blog/render/retrieve/helpers/getAllCached",
];

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();

let heapPeak = 0;
setInterval(() => {
  heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
}, 20).unref();

function scaled(shape) {
  const out = { ...shape };
  if (SCALE === 1) return out;
  out.entries = Math.max(10, Math.round(shape.entries * SCALE));
  out.pages = Math.round((shape.pages || 0) * SCALE);
  out.html = Object.fromEntries(
    Object.entries(shape.html).map(([k, v]) => [k, Math.max(100, Math.round(v * SCALE))])
  );
  if (shape.tags) out.tags = Math.max(5, Math.round(shape.tags * SCALE));
  return out;
}

async function main() {
  const startedAt = Date.now();
  const server = await serve();
  const sites = await seed();
  const seedSeconds = (Date.now() - startedAt) / 1000;
  const request = requester(server.address().port);

  gc();
  const baseHeap = process.memoryUsage().heapUsed;
  const metrics = {};
  const timings = {};

  // Fixed URL lists: the pages that pull the most per render
  const catalogEntry = sites.catalog.entries[Math.floor(sites.catalog.entries.length / 2)];
  const heavyEntry = sites.heavy.entries.slice().sort((a, b) => a.size - b.size)[
    Math.floor(sites.heavy.entries.length / 2)
  ];
  const urls = {
    catalog: ["/", "/archives", "/sitemap.xml", catalogEntry.url, "/tagged/topic-1"],
    heavy: ["/", "/archives", "/sitemap.xml", heavyEntry.url],
  };

  // 1. Cold: the first render of each page in a fresh process
  for (const name of ["catalog", "heavy"]) {
    const result = await sequence(request, sites[name].blog.handle, urls[name]);
    timings[`cold_${name}`] = result.each;
    metrics[`cold_${name}_ms`] = result.ms;
    metrics[`cold_${name}_block_ms`] = result.blockMs;
  }

  // 2. Warm: the same pages again, served from whatever is cached
  for (const name of ["catalog", "heavy"]) {
    const runs = [];
    for (let i = 0; i < 5; i++) {
      runs.push(await sequence(request, sites[name].blog.handle, urls[name]));
    }
    metrics[`warm_${name}_ms`] = median(runs.map((r) => r.ms));
    metrics[`warm_${name}_block_ms`] = Math.max(...runs.map((r) => r.blockMs));
  }

  // 3. The first render after a cacheID bump, as after any sync
  for (const name of ["catalog", "heavy"]) {
    const runs = [];
    for (let i = 0; i < 3; i++) {
      await bump(sites[name].blog);
      runs.push(await sequence(request, sites[name].blog.handle, urls[name]));
    }
    metrics[`bump_${name}_ms`] = median(runs.map((r) => r.ms));
    metrics[`bump_${name}_block_ms`] = Math.max(...runs.map((r) => r.blockMs));
  }

  // 4. The template editor: previews switching between the owner's templates
  for (const name of ["catalog", "heavy"]) {
    const site = sites[name];
    const each = [];
    let blockMs = 0;
    for (let round = 0; round < 3; round++) {
      for (const slug of site.previews) {
        const handle = `preview-of-my-${slug}-on-${site.blog.handle}`;
        const result = await sequence(request, handle, ["/", urls[name][3]]);
        each.push(...result.each.map((r) => r.ms));
        blockMs = Math.max(blockMs, result.blockMs);
      }
    }
    metrics[`preview_${name}_p50_ms`] = percentile(each, 0.5);
    metrics[`preview_${name}_max_ms`] = Math.max(...each);
    metrics[`preview_${name}_block_ms`] = blockMs;
  }

  // 5. Contention: the small sites' latency while the mega sites render,
  // first alone, then while the mega sites are browsed and resynced
  const victims = sites.small.flatMap((site) =>
    ["/", site.entries[0].url, site.entries[1].url].map((url) => [site.blog.handle, url])
  );
  for (const [handle, url] of victims) await request(handle, url);

  const solo = await victimLoad(request, victims, () => sleep(4000));
  metrics.victim_solo_p50_ms = percentile(solo.ms, 0.5);
  metrics.victim_solo_p95_ms = percentile(solo.ms, 0.95);

  loop.reset();
  const busy = await victimLoad(request, victims, () => megaLoad(request, sites, urls));
  metrics.victim_busy_p50_ms = percentile(busy.ms, 0.5);
  metrics.victim_busy_p95_ms = percentile(busy.ms, 0.95);
  metrics.victim_busy_max_ms = Math.max(...busy.ms);
  metrics.busy_block_ms = loop.max / 1e6;

  // 6. Memory: the most the heap held above its post-seed baseline, and what
  // stays after a collection (mostly what the caches keep)
  metrics.heap_peak_mb = (heapPeak - baseHeap) / 1048576;
  gc();
  metrics.heap_retained_mb = (process.memoryUsage().heapUsed - baseHeap) / 1048576;

  const caches = cacheCounters();
  if (caches) {
    metrics.cache_oversize_fills = caches.oversize;
    metrics.cache_uncached_fills = caches.uncachedFills;
    metrics.cache_clone_ms = caches.cloneMs;
    metrics.cache_fill_max_ms = caches.fillMaxMs;
  }

  const result = {
    sha: process.env.BENCHMARK_SHA || null,
    label: args.label || null,
    scale: SCALE,
    seedSeconds,
    shape: shapeSummary(sites),
    metrics: round(metrics),
    timings,
    caches: caches && caches.byCache,
  };

  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, JSON.stringify(result, null, 2));
  }

  console.log(JSON.stringify(result.metrics, null, 2));
  process.exit(0);
}

// --- setup ------------------------------------------------------------------

async function serve() {
  const express = require("express");
  const trace = require("helper/trace");
  const app = express();

  app.use((req, res, next) => {
    req.headers.host = req.headers["x-forwarded-host"];
    next();
  });
  app.use(trace.init);
  // Request logging would time stdout, not rendering
  app.use((req, res, next) => {
    req.log = function () {};
    next();
  });
  app.set("trust proxy", true);
  app.set("etag", false);
  app.use(require("blog"));

  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function seed() {
  await promisify(require("templates"))({ watch: false });

  const context = {};
  await promisify(require("../../tests/util/createUser").bind(context))();

  async function blog() {
    const result = { user: context.user };
    await promisify(require("../../tests/util/createBlog").bind(result))();
    return result.blog;
  }

  async function site(shape, seedName) {
    const created = await blog();
    const entries = content.entries(shape, seedName);
    await mapLimit(entries, 8, (entry) => setEntry(created.id, entry.path, entry));
    const stored = await mapLimit(entries, 8, (entry) =>
      promisify((cb) => Entry.get(created.id, entry.path, (e) => cb(null, e)))()
    );
    return { blog: created, entries: stored.filter((e) => e && !e.page) };
  }

  // The catalog site, on its own template, and the copies it previews
  const catalogShape = scaled(profile.catalog);
  const catalog = await site(catalogShape, "catalog");
  const views = catalogViews(catalogShape);
  const catalogID = await ownTemplate(catalog.blog, "catalog", {
    locals: { page_size: catalogShape.pageSize },
  });
  for (const name of Object.keys(views)) {
    const view = { name, content: views[name] };
    if (VIEW_URLS[name]) view.url = VIEW_URLS[name];
    await setView(catalogID, view);
  }
  await setBlog(catalog.blog.id, { template: catalogID });
  catalog.previews = await previews(catalog.blog, catalogID, profile.catalog.previewTemplates);

  // The heavy site, on a fork of the stock Hypertext template
  const heavyShape = scaled(profile.heavy);
  const heavy = await site(heavyShape, "heavy");
  const heavyID = await ownTemplate(heavy.blog, "hypertext", {
    cloneFrom: "SITE:hypertext",
    locals: { page_size: heavyShape.pageSize, sort_by: heavyShape.sortBy },
  });
  await setBlog(heavy.blog.id, { template: heavyID });
  heavy.previews = await previews(heavy.blog, heavyID, profile.heavy.previewTemplates);

  // Everyone else, on the default template
  const small = [];
  for (let i = 0; i < profile.small.sites; i++) {
    small.push(await site(profile.small, `small-${i}`));
  }

  return { catalog, heavy, small };
}

async function ownTemplate(blog, name, metadata) {
  const created = await createTemplate(blog.id, name, metadata);
  return created.id;
}

// The live template plus copies, by slug, for preview-of-my-<slug>-on-<handle>
async function previews(blog, templateID, count) {
  const slugs = [templateID.split(":").pop()];
  for (let i = 1; i < count; i++) {
    const id = await ownTemplate(blog, `variant${i}`, { cloneFrom: templateID });
    slugs.push(id.split(":").pop());
  }
  return slugs;
}

async function bump(blog) {
  await setBlog(blog.id, { cacheID: Date.now() });
}

// --- load -------------------------------------------------------------------

function requester(port) {
  return async function request(handle, url) {
    const startedAt = performance.now();
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      redirect: "manual",
      headers: {
        "x-forwarded-host": `${handle}.${config.host}`,
        "x-forwarded-proto": "https",
      },
    });
    const body = await res.arrayBuffer();
    const ms = performance.now() - startedAt;
    if (res.status >= 400) {
      throw new Error(`${handle}${url} returned ${res.status}`);
    }
    return { url, ms, bytes: body.byteLength, status: res.status };
  };
}

// Requests one after another; the total time and the longest event loop
// block while they ran
async function sequence(request, handle, urls) {
  loop.reset();
  const each = [];
  for (const url of urls) each.push(await request(handle, url));
  return {
    ms: each.reduce((sum, r) => sum + r.ms, 0),
    blockMs: loop.max / 1e6,
    each: each.map((r) => ({ url: r.url, ms: round(r.ms), bytes: r.bytes })),
  };
}

// Two visitors browsing the small sites until `until` settles
async function victimLoad(request, victims, until) {
  const ms = [];
  let done = false;
  let n = 0;

  async function visitor() {
    while (!done) {
      const [handle, url] = victims[n++ % victims.length];
      ms.push((await request(handle, url)).ms);
    }
  }

  const visitors = [visitor(), visitor()];
  await until();
  done = true;
  await Promise.all(visitors);
  return { ms };
}

// The mega sites resync and get browsed: each round bumps both cacheIDs,
// then renders their heaviest pages and two previews at once
async function megaLoad(request, sites, urls) {
  for (let round = 0; round < 4; round++) {
    await bump(sites.catalog.blog);
    await bump(sites.heavy.blog);
    const work = [];
    for (const name of ["catalog", "heavy"]) {
      const site = sites[name];
      for (const url of urls[name]) work.push(request(site.blog.handle, url));
      const slug = site.previews[1 + (round % (site.previews.length - 1))];
      work.push(request(`preview-of-my-${slug}-on-${site.blog.handle}`, "/"));
    }
    await Promise.all(work);
  }
}

// --- reporting --------------------------------------------------------------

function cacheCounters() {
  const byCache = {};
  const totals = { oversize: 0, uncachedFills: 0, cloneMs: 0, fillMaxMs: 0 };
  let found = false;

  for (const name of CACHE_STATS) {
    let stats;
    try {
      stats = require(name)._stats;
    } catch (e) {
      continue;
    }
    if (typeof stats !== "function") continue;
    const s = stats();
    const c = s.counters;
    if (!c) continue;
    found = true;
    byCache[s.name] = {
      size: s.size,
      calculatedSize: s.calculatedSize,
      maxSize: s.maxSize,
      hit: c.hit,
      miss: c.miss,
      bypass: c.bypass,
      fills: c.fills,
      fillMaxMs: round(c.fillMaxMs),
      uncachedFills: c.uncachedFills,
      oversize: c.uncachedBy.oversize,
      clones: c.clones,
      cloneMs: round(c.cloneMs),
      evictions: c.evictions,
    };
    totals.oversize += c.uncachedBy.oversize;
    totals.uncachedFills += c.uncachedFills;
    totals.cloneMs += c.cloneMs;
    totals.fillMaxMs = Math.max(totals.fillMaxMs, c.fillMaxMs);
  }

  return found ? { ...totals, byCache } : null;
}

function shapeSummary(sites) {
  const sum = (entries, field) =>
    entries.reduce((total, e) => total + (e[field] || "").length, 0);
  return Object.fromEntries(
    ["catalog", "heavy"].map((name) => [
      name,
      {
        entries: sites[name].entries.length,
        htmlMB: round(sum(sites[name].entries, "html") / 1048576),
        previews: sites[name].previews.length,
      },
    ])
  );
}

// --- helpers ----------------------------------------------------------------

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

function median(values) {
  return percentile(values, 0.5);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gc() {
  if (global.gc) global.gc();
}

function round(value) {
  if (typeof value === "number") return Math.round(value * 10) / 10;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, round(v)]));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
