#!/usr/bin/env node
// Measures what many packs cost in the git store (app/clients/git/store), to
// decide whether a multi-pack index is worth building (#2259).
//
// It uses the real store modules, not ports of them. A synthetic repository is
// pushed through receive() with a real `git push`, with the same commits,
// objects and refs every time but grouped into 1, 8, 32, 64 or 128 pushes, so
// 1 to 128 packs. Each repository is copied into MinIO, and every operation is
// run against the copy through toxiproxy, which adds S3-like latency and a
// bandwidth limit, with the AWS SDK's requests counted:
//
//   clone        advertise + serve of a request with no haves, to a sink that
//                notes when the first byte and the first pack byte arrive
//   push         one file changed, a real `git push` through receive()
//   commit       one file written by Blot (commit.js)
//   fetch        a client one push behind (it asks for the new commit and a
//                new annotated tag)
//   materialize  the folder brought forward by a one-file change
//
// Each is run cold (empty cache, fresh store object) and then warm (the same
// cache, another change of the same kind).
//
//   docker compose -f scripts/git/measure-packs/docker-compose.yml up -d --wait
//   node scripts/git/measure-packs.js [--packs 1,8,32,64,128] [--reps 3]
//        [--commits 128] [--files 250] [--latency 25] [--jitter 5]
//        [--rate-mbps 60] [--json out.json]
//   docker compose -f scripts/git/measure-packs/docker-compose.yml down -v
//
// This is a script, not a spec: nothing here runs in CI.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { Writable } = require("stream");
const {
  S3Client,
  CreateBucketCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");

const STORE = path.join(__dirname, "../../app/clients/git/store");
const manifest = require(path.join(STORE, "manifest"));
const createCache = require(path.join(STORE, "cache"));
const createMemoryStore = require(path.join(STORE, "objectStore/memory"));
const createS3Store = require(path.join(STORE, "objectStore/s3"));
const createReader = require(path.join(STORE, "reader"));
const commit = require(path.join(STORE, "commit"));
const materialize = require(path.join(STORE, "materialize"));
const createFolderSink = require(path.join(STORE, "folderSink"));
const { mapLimit } = require(path.join(STORE, "limit"));
const { idxKey } = require(path.join(STORE, "layout"));
const { serve } = require(path.join(STORE, "clone"));
const { createReceiveServer, push } = require(path.join(STORE, "tests/helpers/receiveServer"));
const { startServer, runGit } = require(path.join(STORE, "tests/helpers/upload-server"));

// ---- options ---------------------------------------------------------------

function option(name, fallback) {
  const at = process.argv.indexOf("--" + name);
  return at === -1 ? fallback : process.argv[at + 1];
}

const PACK_COUNTS = String(option("packs", "1,8,32,64,128")).split(",").map(Number);
const REPS = Number(option("reps", 1));
const COMMITS = Number(option("commits", 128));
const FILES = Number(option("files", 250)); // new text files in each commit
const LATENCY_MS = Number(option("latency", 25));
const JITTER_MS = Number(option("jitter", 5));
const RATE_MBPS = Number(option("rate-mbps", 60)); // per connection, each way
const PREFETCH_ONLY = process.argv.includes("--prefetch-only");
const JSON_OUT =option("json", null);
const CACHE_BYTES = Number(option("cache-mib", 512)) * 1024 * 1024;

const DIRECT = process.env.MEASURE_S3_DIRECT || "http://127.0.0.1:19200";
const PROXIED = process.env.MEASURE_S3_PROXIED || "http://127.0.0.1:19210";
const TOXIPROXY = process.env.MEASURE_TOXIPROXY || "http://127.0.0.1:18480";
const BUCKET = "measure-packs-" + crypto.randomBytes(4).toString("hex");

// ---- helpers ---------------------------------------------------------------

const log = (...args) => console.error("[measure-packs]", ...args);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

function makeClient(endpoint) {
  return new S3Client({
    region: "us-east-1",
    endpoint,
    forcePathStyle: true,
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: "measure", secretAccessKey: "measure-secret" },
  });
}

// What the SDK sent, one entry per attempt, grouped by what it was for
function emptyCounts() {
  return { total: 0, head: 0, idx: 0, idxBytes: 0, pack: 0, packBytes: 0, manifest: 0, rev: 0, put: 0, putBytes: 0, list: 0, other: 0, bytesIn: 0 };
}

function instrument(client, counts) {
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const c = counts.current;
      const input = args.input || {};
      const key = String(input.Key || "");
      const headers = (args.request && args.request.headers) || {};
      const reqBytes = Number(headers["content-length"] || 0);
      const name = context.commandName;
      let bytes = 0;
      try {
        const out = await next(args);
        if (name === "GetObjectCommand") bytes = Number((out.response && out.response.headers && out.response.headers["content-length"]) || 0);
        return out;
      } finally {
        c.total++;
        c.bytesIn += bytes;
        if (name === "PutObjectCommand" || name === "UploadPartCommand" || name === "CreateMultipartUploadCommand" || name === "CompleteMultipartUploadCommand") {
          c.put++;
          c.putBytes += reqBytes;
        } else if (name === "ListObjectsV2Command") c.list++;
        else if (key.includes("/manifests/")) c.manifest++;
        else if (key.endsWith(".idx")) {
          c.idx++;
          c.idxBytes += bytes;
        } else if (key.endsWith(".pack")) {
          c.pack++;
          c.packBytes += bytes;
        } else if (key.endsWith(".rev")) c.rev++;
        else c.other++;
        if (name === "HeadObjectCommand") c.head++;
      }
    },
    { step: "finalizeRequest", name: "countAttempts", priority: "low" }
  );
  return client;
}

// A client, a store over it and a cache directory: what one process of the host has
function session(endpoint, prefix, tmp, label) {
  const counts = { current: emptyCounts() };
  const client = instrument(makeClient(endpoint), counts);
  const store = createS3Store({ client, bucket: BUCKET, prefix });
  const dir = fs.mkdtempSync(path.join(tmp, "cache-" + label + "-"));
  const cache = createCache({ dir, maxBytes: CACHE_BYTES });
  return {
    client,
    store,
    cache,
    dir,
    lock: createLock(),
    counts,
    // Runs fn and reports wall time and what it asked of S3
    async measure(fn) {
      counts.current = emptyCounts();
      const started = process.hrtime.bigint();
      const extra = await fn();
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      return { ms, ...counts.current, ...(extra || {}) };
    },
  };
}

// ---- toxiproxy -------------------------------------------------------------

async function toxi(method, url, body) {
  const res = await fetch(TOXIPROXY + url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok && res.status !== 404) throw new Error(method + " " + url + " " + res.status + " " + (await res.text()));
  return res.status === 204 || res.status === 404 ? null : res.json().catch(() => null);
}

async function setProfile() {
  const proxy = await toxi("GET", "/proxies/minio");
  for (const t of (proxy && proxy.toxics) || []) await toxi("DELETE", "/proxies/minio/toxics/" + t.name);
  if (LATENCY_MS) {
    await toxi("POST", "/proxies/minio/toxics", { name: "latency", type: "latency", stream: "downstream", toxicity: 1, attributes: { latency: LATENCY_MS, jitter: JITTER_MS } });
  }
  if (RATE_MBPS) {
    for (const stream of ["upstream", "downstream"]) {
      await toxi("POST", "/proxies/minio/toxics", { name: "bw-" + stream, type: "bandwidth", stream, toxicity: 1, attributes: { rate: Math.round(RATE_MBPS * 1024) } });
    }
  }
}

// ---- the synthetic repository ---------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Measure",
  GIT_AUTHOR_EMAIL: "measure@example.com",
  GIT_COMMITTER_NAME: "Measure",
  GIT_COMMITTER_EMAIL: "measure@example.com",
};

function git(cwd, args, extraEnv = {}) {
  const r = spawnSync("git", ["-c", "gc.auto=0", ...args], { cwd, env: { ...GIT_ENV, ...extraEnv }, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error("git " + args.join(" ") + ": " + r.stderr);
  return r.stdout.toString().trim();
}

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

const WORDS = Array.from({ length: 4000 }, (_, i) => {
  const next = prng(i * 7919 + 13);
  let w = "";
  for (let n = 3 + (next() % 7); n > 0; n--) w += String.fromCharCode(97 + (next() % 26));
  return w;
});

function paragraph(seed, bytes) {
  const next = prng(seed);
  let out = "";
  while (out.length < bytes) out += WORDS[next() % WORDS.length] + (next() % 12 === 0 ? ".\n" : " ");
  return out;
}

function noise(seed, bytes) {
  const next = prng(seed);
  const b = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 4) b.writeUInt32LE(next(), i);
  return b;
}

// COMMITS commits, each adding FILES small text files and an image to its own
// folder and editing three files in notes/ (so there are deltas), then a few
// more commits (C1 to C3) which the operations push one at a time
function buildSource(tmp) {
  const dir = path.join(tmp, "source");
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "master"]);

  const commits = [];
  const note = (i) => paragraph(900 + i, 6000);
  fs.mkdirSync(path.join(dir, "notes"));
  for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(dir, "notes", "n" + i + ".txt"), note(i));

  function makeCommit(n) {
    const folder = path.join(dir, "posts", "c" + n);
    fs.mkdirSync(folder, { recursive: true });
    for (let f = 0; f < (n <= COMMITS ? FILES : 1); f++) fs.writeFileSync(path.join(folder, "f" + f + ".txt"), paragraph(n * 1000 + f, 700 + ((n * 31 + f * 17) % 1500)));
    if (n <= COMMITS) fs.writeFileSync(path.join(folder, "photo.jpg"), noise(n, 200 * 1024));
    for (let i = 0; i < 3; i++) fs.appendFileSync(path.join(dir, "notes", "n" + i + ".txt"), "\nEdit " + n + ": " + paragraph(n * 10 + i, 120));
    git(dir, ["add", "-A"]);
    const date = new Date(Date.UTC(2026, 0, 1) + n * 3600 * 1000).toISOString();
    git(dir, ["commit", "-q", "-m", "Commit " + n], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    return git(dir, ["rev-parse", "HEAD"]);
  }

  for (let n = 1; n <= COMMITS; n++) commits.push(makeCommit(n));
  git(dir, ["tag", "-a", "-m", "version one", "v1", commits[COMMITS - 1]]);
  git(dir, ["tag", "-a", "-m", "version two", "v2", commits[COMMITS - 1]]);
  git(dir, ["tag", "light1", commits[COMMITS - 1]]);

  // C1 to C3 each change one existing file in notes/ (a delta against a
  // blob in the newest pack), and add one small file
  const extra = [];
  for (let k = 1; k <= 3; k++) {
    const n = COMMITS + k;
    const folder = path.join(dir, "posts", "c" + n);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "f0.txt"), paragraph(n * 1000, 1200));
    fs.appendFileSync(path.join(dir, "notes", "n" + (k - 1) + ".txt"), "\nEdit " + n + ": " + paragraph(n, 120));
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "Change " + k]);
    extra.push(git(dir, ["rev-parse", "HEAD"]));
  }
  git(dir, ["tag", "-a", "-m", "version three", "v3", extra[0]]);
  git(dir, ["reset", "-q", "--hard", commits[COMMITS - 1]]);

  const counts = git(dir, ["count-objects", "-v"]);
  return { dir, commits, extra, counts };
}

// The pushes which build a repository of `packs` packs: the commits cut into
// that many groups, the last with the tags
async function buildRepository(source, packs, tmp) {
  const store = createMemoryStore();
  const cache = createCache({ dir: fs.mkdtempSync(path.join(tmp, "cache-build-")), maxBytes: CACHE_BYTES });
  const server = await createReceiveServer({ store, cache, lock: createLock() });
  try {
    for (let k = 1; k <= packs; k++) {
      const upto = Math.round((k * COMMITS) / packs);
      const refs = [source.commits[upto - 1] + ":refs/heads/master"];
      if (k === packs) refs.push("refs/tags/v1:refs/tags/v1", "refs/tags/v2:refs/tags/v2", "refs/tags/light1:refs/tags/light1");
      const result = await push(source.dir, ["-q", server.url, ...refs]);
      if (result.code !== 0) throw new Error("push " + k + " failed: " + result.stderr);
    }
    const bad = server.results.filter((r) => r.outcome !== "ok");
    if (bad.length) throw new Error("a push was not ok: " + JSON.stringify(bad[0]));
  } finally {
    await server.close();
  }
  const m = await manifest.read(store);
  if (m.packs.length !== packs) throw new Error("expected " + packs + " packs, the manifest lists " + m.packs.length);
  return { store, manifest: m };
}

async function loadInto(direct, prefix, memory) {
  const s3 = createS3Store({ client: direct, bucket: BUCKET, prefix });
  for (const [key, body] of memory.objects) await s3.put(key, Buffer.from(body));
}

async function copyPrefix(direct, from, to) {
  let token;
  do {
    const out = await direct.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: from, ContinuationToken: token }));
    for (const item of out.Contents || []) {
      await direct.send(new CopyObjectCommand({ Bucket: BUCKET, Key: to + item.Key.slice(from.length), CopySource: BUCKET + "/" + item.Key }));
    }
    token = out.NextContinuationToken;
  } while (token);
}

async function deletePrefix(direct, prefix) {
  let token;
  do {
    const out = await direct.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    const keys = (out.Contents || []).map((item) => ({ Key: item.Key }));
    if (keys.length) await direct.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys, Quiet: true } }));
    token = out.NextContinuationToken;
  } while (token);
}

// ---- operations ------------------------------------------------------------

const pkt = (text) => Buffer.concat([Buffer.from((text.length + 4).toString(16).padStart(4, "0")), Buffer.from(text)]);
const CAPS = "multi_ack_detailed no-done side-band-64k ofs-delta agent=measure";

function request({ wants, haves = [], done = false }) {
  const parts = wants.map((oid, i) => pkt("want " + oid + (i === 0 ? " " + CAPS : "") + "\n"));
  parts.push(Buffer.from("0000"));
  for (const oid of haves) parts.push(pkt("have " + oid + "\n"));
  parts.push(done ? pkt("done\n") : Buffer.from("0000"));
  return Buffer.concat(parts);
}

// A response which notes when bytes arrive, as the client would see them
function sink() {
  const at = { start: process.hrtime.bigint(), first: null, pack: null, bytes: 0 };
  const ms = () => Number(process.hrtime.bigint() - at.start) / 1e6;
  const out = new Writable({
    write(chunk, enc, cb) {
      if (at.first === null) at.first = ms();
      if (at.pack === null && chunk.includes("PACK")) at.pack = ms();
      at.bytes += chunk.length;
      cb();
    },
  });
  return { out, at };
}

async function doClone(s) {
  const { out, at } = sink();
  const m = await manifest.read(s.store);
  const wants = [...new Set(Object.values(m.refs))];
  const finished = new Promise((resolve) => out.on("finish", resolve));
  const result = await serve({ store: s.store, cache: s.cache, manifest: m, body: request({ wants, done: true }), out });
  await finished;
  return { firstMs: at.first, packMs: at.pack, sent: at.bytes, packs: result.packs || m.packs.length };
}

async function doFetch(s, wants, haves) {
  const { out, at } = sink();
  const m = await manifest.read(s.store);
  const finished = new Promise((resolve) => out.on("finish", resolve));
  const result = await serve({ store: s.store, cache: s.cache, manifest: m, body: request({ wants, haves }), out });
  await finished;
  if (result.negotiated) throw new Error("fetch needed another round: " + JSON.stringify(result));
  return { firstMs: at.first, packMs: at.pack, sent: at.bytes, packs: result.packs, floor: result.floor };
}

async function doPush(s, server, source, sha, extraRefs = []) {
  const before = server.results.length;
  const result = await push(source.dir, ["-q", server.url, sha + ":refs/heads/master", ...extraRefs]);
  if (result.code !== 0 || server.results.length !== before + 1 || server.results[before].outcome !== "ok") {
    throw new Error("measured push failed: " + result.stderr + JSON.stringify(server.results[before]));
  }
}

// Pushes through the direct (unlatencied) path, for setting a repository up
async function setupPushes(direct, prefix, tmp, source, shas, withTag) {
  const s = session(DIRECT, prefix, tmp, "setup");
  const server = await createReceiveServer({ store: s.store, cache: s.cache, lock: s.lock });
  try {
    for (let i = 0; i < shas.length; i++) {
      await doPush(s, server, source, shas[i], i === 0 && withTag ? ["refs/tags/v3:refs/tags/v3"] : []);
    }
  } finally {
    await server.close();
    s.client.destroy();
  }
}

async function runOne(P, rep, ctx) {
  const { direct, tmp, source } = ctx;
  const base = "base/P" + P + "/";
  // MinIO's data is in memory, so each copy is deleted after its operation
  let current = null;
  const fresh = async (name) => {
    if (current) await deletePrefix(direct, current);
    current = "run/P" + P + "-" + rep + "-" + name + "/";
    await copyPrefix(direct, base, current);
    return current;
  };
  const out = {};
  const sessions = [];
  const proxied = (prefix, label) => {
    const s = session(PROXIED, prefix, tmp, label);
    sessions.push(s);
    return s;
  };
  const T0 = source.commits[COMMITS - 1];
  const [C1, C2, C3] = source.extra;
  const v3 = git(source.dir, ["rev-parse", "v3"]);

  // clone. The clone's index reads do not go through the cache, so warm
  // is the same work
  {
    const s = proxied(await fresh("clone"), "clone");
    out.clone = { cold: await s.measure(() => doClone(s)), warm: await s.measure(() => doClone(s)) };
  }

  // push
  {
    const s = proxied(await fresh("push"), "push");
    const server = await createReceiveServer({ store: s.store, cache: s.cache, lock: s.lock });
    try {
      const cold = await s.measure(() => doPush(s, server, source, C1, ["refs/tags/v3:refs/tags/v3"]));
      const warm = await s.measure(() => doPush(s, server, source, C2));
      out.push = { cold, warm };
    } finally {
      await server.close();
    }
  }

  // commit
  {
    const s = proxied(await fresh("commit"), "commit");
    const write = (file, n) => commit({ store: s.store, cache: s.cache, lock: s.lock, path: "/notes/" + file, contents: Buffer.from(paragraph(n, 6500)) });
    const check = (r) => {
      if (r.outcome !== "ok" || !r.commit) throw new Error("commit failed: " + JSON.stringify(r));
    };
    out.commit = {
      cold: await s.measure(async () => check(await write("n2.txt", 1))),
      warm: await s.measure(async () => check(await write("n1.txt", 2))),
    };
  }

  // fetch, by a client at T0 when the server is one push on
  {
    const prefix = await fresh("fetch");
    await setupPushes(direct, prefix, tmp, source, [C1], true);
    const s = proxied(prefix, "fetch");
    out.fetch = {
      cold: await s.measure(() => doFetch(s, [C1, v3], [T0])),
      warm: await s.measure(() => doFetch(s, [C1, v3], [T0])),
    };
  }

  // materialize a one-file change: C1 to C2 cold, C2 to C3 warm
  {
    const prefix = await fresh("materialize");
    await setupPushes(direct, prefix, tmp, source, [C1, C2, C3], false);
    const folder = fs.mkdtempSync(path.join(tmp, "folder-"));
    spawnSync("sh", ["-c", "git archive " + C1 + " | tar -x -C " + JSON.stringify(folder)], { cwd: source.dir, maxBuffer: 1 << 30 });
    const s = proxied(prefix, "materialize");
    const step = (from, to) => async () => {
      const m = await manifest.read(s.store);
      const reader = createReader({ store: s.store, cache: s.cache, packs: m.packs, scratch: s.cache });
      const r = await materialize({ reader, from, to, sink: createFolderSink({ root: folder }) });
      return { written: r.written, removed: r.removed };
    };
    out.materialize = { cold: await s.measure(step(C1, C2)), warm: await s.measure(step(C2, C3)) };
    fs.rmSync(folder, { recursive: true, force: true });
  }

  for (const s of sessions) s.client.destroy();
  await deletePrefix(direct, current);
  return out;
}

// ---- main ------------------------------------------------------------------

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "measure-packs-"));
  const direct = makeClient(DIRECT);
  const results = { options: { PACK_COUNTS, REPS, COMMITS, FILES, LATENCY_MS, JITTER_MS, RATE_MBPS, CACHE_BYTES }, perPack: {} };

  try {
    await direct.send(new CreateBucketCommand({ Bucket: BUCKET }));

    log("building the source repository in", tmp);
    const source = buildSource(tmp);
    log(source.counts.split("\n").join(" "));

    for (const P of PACK_COUNTS) {
      log("building a repository of", P, "packs");
      const built = await buildRepository(source, P, tmp);
      await loadInto(direct, "base/P" + P + "/", built.store);

      // The same repository, whole, through a real git client, as a check on
      // the build (it is not measured)
      const verify = await startServer({ store: createS3Store({ client: direct, bucket: BUCKET, prefix: "base/P" + P + "/" }), manifest: () => built.manifest });
      const cloneDir = path.join(tmp, "verify-" + P);
      const cloned = await runGit(["-c", "transfer.fsckObjects=true", "clone", "-q", verify.url, cloneDir]);
      await verify.close();
      if (cloned.code !== 0) throw new Error("a real git clone of P=" + P + " failed: " + cloned.stderr);
      fs.rmSync(cloneDir, { recursive: true, force: true });

      const packBytes = built.manifest.packs.reduce((n, p) => n + p.size, 0);
      const idxBytes = built.manifest.packs.reduce((n, p) => n + p.idxSize, 0);
      const objects = built.manifest.packs.reduce((n, p) => n + p.objects, 0);
      results.perPack[P] = { packs: P, objects, packBytes, idxBytes, runs: [] };

      await setProfile();

      // What reading every .idx whole, once, would cost (8 at a time, as the
      // reader asks its packs): the cheap alternative to a multi-pack index
      results.perPack[P].prefetch = [];
      for (let rep = 0; rep < REPS; rep++) {
        const s = session(PROXIED, "base/P" + P + "/", tmp, "prefetch");
        results.perPack[P].prefetch.push(
          await s.measure(async () => {
            const m = await manifest.read(s.store);
            await mapLimit(m.packs, 8, (p) => s.store.get(idxKey(p.name)));
          })
        );
        s.client.destroy();
      }

      for (let rep = 0; rep < (PREFETCH_ONLY ? 0 : REPS); rep++) {
        log("measuring P =", P, "rep", rep + 1);
        results.perPack[P].runs.push(await runOne(P, rep, { direct, tmp, source }));
      }
      await deletePrefix(direct, "base/P" + P + "/");
    }
  } finally {
    direct.destroy();
    fs.rmSync(tmp, { recursive: true, force: true });
    // Whatever finished is reported, even if a later pack count failed
    if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
    report(results);
  }
}

// ---- report ----------------------------------------------------------------

const OPS = ["clone", "push", "commit", "fetch", "materialize"];

function cell(P, results, op, temp) {
  const runs = results.perPack[P].runs.map((r) => r[op][temp]);
  const last = runs[runs.length - 1];
  return { ...last, ms: median(runs.map((r) => r.ms)), firstMs: median(runs.map((r) => r.firstMs || 0)), packMs: median(runs.map((r) => r.packMs || 0)) };
}

const f0 = (n) => Math.round(n).toLocaleString("en-US");
const mb = (n) => (n / 1048576).toFixed(1);

function report(results) {
  const Ps = Object.keys(results.perPack).map(Number).filter((P) => results.perPack[P].runs.length === REPS || PREFETCH_ONLY);
  if (PREFETCH_ONLY) {
    console.log("| | " + Ps.map((P) => P + " packs").join(" | ") + " |\n|---|" + Ps.map(() => "---:|").join(""));
    console.log("| all .idx fetched whole, ms | " + Ps.map((P) => f0(median(results.perPack[P].prefetch.map((r) => r.ms)))).join(" | ") + " |");
    console.log("| requests | " + Ps.map((P) => f0(results.perPack[P].prefetch[0].total)).join(" | ") + " |");
    console.log("| KiB | " + Ps.map((P) => f0(results.perPack[P].prefetch[0].bytesIn / 1024)).join(" | ") + " |");
    return;
  }
  const lines = [];
  const row = (cells) => lines.push("| " + cells.join(" | ") + " |");
  const head = (title) => {
    lines.push("", "**" + title + "**", "");
    row(["operation", ...Ps.map((P) => P + " packs")]);
    row(["---", ...Ps.map(() => "---:")]);
  };

  const sample = results.perPack[Ps[0]];
  lines.push(
    "Synthetic repository: " + COMMITS + " commits, " + f0(sample.objects) + " objects, " + mb(sample.packBytes) + " MiB of packs, same commits and refs in every case.",
    "Latency " + LATENCY_MS + " ms (+/-" + JITTER_MS + ") added to every S3 response, " + RATE_MBPS + " MB/s per connection each way, " + REPS + " rep(s), median wall time."
  );

  head("Wall time, ms (cold / warm)");
  for (const op of OPS) row([op, ...Ps.map((P) => f0(cell(P, results, op, "cold").ms) + " / " + f0(cell(P, results, op, "warm").ms))]);
  row(["clone, first byte", ...Ps.map((P) => f0(cell(P, results, "clone", "cold").firstMs))]);
  row(["clone, first pack byte", ...Ps.map((P) => f0(cell(P, results, "clone", "cold").packMs))]);
  row(["fetch, first pack byte", ...Ps.map((P) => f0(cell(P, results, "fetch", "cold").packMs) + " / " + f0(cell(P, results, "fetch", "warm").packMs))]);

  head("S3 requests, all kinds (cold / warm)");
  for (const op of OPS) row([op, ...Ps.map((P) => f0(cell(P, results, op, "cold").total) + " / " + f0(cell(P, results, op, "warm").total))]);

  head("of which on .idx files (cold / warm)");
  for (const op of OPS) row([op, ...Ps.map((P) => f0(cell(P, results, op, "cold").idx) + " / " + f0(cell(P, results, op, "warm").idx))]);

  head("Bytes read from S3, MiB (cold / warm)");
  for (const op of OPS) row([op, ...Ps.map((P) => mb(cell(P, results, op, "cold").bytesIn) + " / " + mb(cell(P, results, op, "warm").bytesIn))]);

  head("Bytes of .idx read, KiB (cold / warm)");
  for (const op of OPS) row([op, ...Ps.map((P) => f0(cell(P, results, op, "cold").idxBytes / 1024) + " / " + f0(cell(P, results, op, "warm").idxBytes / 1024))]);

  head("Index size");
  row(["total .idx KiB", ...Ps.map((P) => f0(results.perPack[P].idxBytes / 1024))]);

  console.log(lines.join("\n"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
