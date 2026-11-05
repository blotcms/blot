#!/usr/bin/env node
// Render-path micro benchmark: seeds one blog into an empty Redis, serves it
// in-process through the real blog router, then requests every entry page
// (or the index pages, or 404s) one at a time, as a crawler filling a cold
// proxy cache would. Reports per-request latency and how many bytes each
// request read from Redis with MGET (the entry reads), so a change that stops
// a render reading something it does not need shows up as fewer bytes even
// when timing is noisy.
//
// Run with NODE_PATH=app against a throwaway Redis (it writes the blog and
// flushes nothing):
//
//   node scripts/benchmarks/render-pages.js [--shape typical|heavy]
//     [--entries N] [--rounds R] [--phase entries|index|notfound|all]
//     [--template SITE:blog] [--output result.json]
//
// --shape heavy uses the mega benchmark's "heavy" site (median 120 KB of HTML
// per entry, a tail to 2.8 MB); typical is a 400-entry blog of 6 KB posts.
const http = require("http");
const fs = require("fs");
const { promisify } = require("util");

const args = parseArgs(process.argv.slice(2));
const content = require("./mega/content");
const profile = require("./mega/profile");

const config = require("config");
const client = require("models/client");
const Entry = require("models/entry");
const Blog = require("models/blog");

const SHAPES = {
  typical: {
    entries: 400,
    pages: 5,
    html: { p50: 6000, p90: 20000, p99: 60000, max: 120000 },
    teaser: { p50: 600, p90: 1000, p99: 1500, max: 1500 },
    tags: 40,
    tagsPerEntry: { p50: 2, p90: 4, p99: 6, max: 8 },
    tagSkew: 0.8,
    years: 6,
  },
  heavy: profile.heavy,
};

// Bytes of entry JSON read from Redis while a request is being served
let mgetBytes = 0;
const mGet = client.mGet.bind(client);
client.mGet = async function (keys) {
  const values = await mGet(keys);
  for (const value of values || []) if (value) mgetBytes += value.length;
  return values;
};

async function main() {
  const shape = Object.assign({}, SHAPES[args.shape || "typical"]);
  if (args.entries) shape.entries = Number(args.entries);
  const rounds = Number(args.rounds || 3);
  const phase = args.phase || "all";

  const server = await serve();
  const port = server.address().port;
  const { blog, urls } = await seed(shape);
  const request = requester(port, blog.handle);

  // Fill the view caches so every phase times renders, not template loading
  for (const url of ["/", urls[0], "/nope"]) await request(url);

  const phases = {
    entries: urls,
    index: ["/", "/page/2", "/page/3"],
    notfound: urls.slice(0, 50).map((url) => url + "-missing"),
  };

  const results = {};

  for (const [name, list] of Object.entries(phases)) {
    if (phase !== "all" && phase !== name) continue;
    const ms = [];
    let bytes = 0;
    let errors = 0;
    for (let round = 0; round < rounds; round++) {
      for (const url of list) {
        mgetBytes = 0;
        const res = await request(url);
        ms.push(res.ms);
        bytes += mgetBytes;
        if (res.status >= 500) errors++;
      }
    }
    ms.sort((a, b) => a - b);
    results[name] = {
      requests: ms.length,
      p50_ms: round2(ms[Math.floor(ms.length * 0.5)]),
      p95_ms: round2(ms[Math.floor(ms.length * 0.95)]),
      total_ms: Math.round(ms.reduce((a, b) => a + b, 0)),
      redis_mget_kb_per_request: round2(bytes / ms.length / 1024),
      errors,
    };
  }

  const output = { shape: args.shape || "typical", entries: shape.entries, rounds, results };
  console.log(JSON.stringify(output, null, 2));
  if (args.output) fs.writeFileSync(args.output, JSON.stringify(output, null, 2));
  server.close();
  process.exit(0);
}

async function serve() {
  const express = require("express");
  const app = express();
  app.use((req, res, next) => {
    req.headers.host = req.headers["x-forwarded-host"];
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

async function seed(shape) {
  await promisify(require("templates"))({ watch: false });
  const context = {};
  await promisify(require("../tests/util/createUser").bind(context))();
  const result = { user: context.user };
  await promisify(require("../tests/util/createBlog").bind(result))();
  const blog = result.blog;
  if (args.template)
    await promisify(Blog.set)(blog.id, { template: args.template });

  const entries = content.entries(shape, "render-pages");
  const log = console.log;
  console.log = function () {}; // Entry.set logs every write
  for (const entry of entries)
    await promisify(Entry.set)(blog.id, entry.path, entry);
  console.log = log;

  const urls = [];
  for (const entry of entries) {
    const stored = await new Promise((resolve) =>
      Entry.get(blog.id, entry.path, resolve)
    );
    if (stored && !stored.page && !stored.draft) urls.push(stored.url);
  }

  return { blog, urls };
}

function requester(port, handle) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const host = handle + "." + config.host;
  return (path) =>
    new Promise((resolve, reject) => {
      const startedAt = performance.now();
      http
        .get(
          {
            port,
            host: "127.0.0.1",
            path,
            agent,
            headers: { "x-forwarded-host": host, "x-forwarded-proto": "https" },
          },
          (res) => {
            res.resume();
            res.on("end", () =>
              resolve({ ms: performance.now() - startedAt, status: res.statusCode })
            );
          }
        )
        .on("error", reject);
    });
}

function round2(n) {
  return Math.round(n * 100) / 100;
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
