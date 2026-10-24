// The client side of the swap-under-load e2e (swap-load.sh): a load
// generator that runs through a blue-green.sh swap, and the single requests the
// script asserts on between swaps. Plain node, no dependencies. Needs
// swap-load-stub.js as the upstream.
//
//   node swap-load.js load              until SIGTERM, then a summary; exit 1
//                                        if any request failed or was wrong
//   node swap-load.js warm              cache every page, require a HIT on the 2nd request
//   node swap-load.js get HOST PATH     one request: "status gen cache"
//   node swap-load.js bump HOST         the upstream's page for HOST changes,
//                                        WITHOUT a purge (what a missed purge is)
//   node swap-load.js change HOST      bump, then purge, as Node does after an edit
//   node swap-load.js hit HOST PATH     require HIT of the upstream's current generation
//   node swap-load.js fresh HOST PATH   require the upstream's current generation
//                                        (so nothing older was served from a cache)
//   node swap-load.js purge-works HOST  HIT, change + purge, MISS of the new
//                                        generation, then HIT of it
//   node swap-load.js fill PREFIX        until SIGTERM, request many distinct pages
//                                        of PREFIX1..PREFIX6.<BLOT_HOST>, appending
//                                        each URL to FILL_FILE: pages a container
//                                        caches that no other container knows of
//   node swap-load.js change-fill PREFIX change (bump + purge) those hosts
//   node swap-load.js check-fill PREFIX  count the pages FILL_FILE lists that are
//                                        older than the upstream's generation
//
// The requests go to the proxy on 127.0.0.1:443 (TLS, SNI and Host = the blog
// host, as proxy/deploy/common.sh's https_status does) and the purges to the
// internal listener on 127.0.0.1:8077, the way Node sends them. Environment:
// STUB_URL (http://127.0.0.1:8090), PROXY_HOST (127.0.0.1), PURGE_URL
// (http://127.0.0.1:8077), BLOT_HOST (blot.im), PURGE_MS (500), WORKERS (24),
// MARKS (a file the driver appends "start <ms>" / "end <ms>" lines to),
// ALLOW_RESETS (1: a new connection reset before any response byte is counted
// and reported, not a failure; see isHandshakeReset), FILL_FILE.
//
// What "wrong" means. The upstream's answer for a (host, path) is a function of
// the host's generation, which a "change" bumps. A cached answer is allowed to
// be any generation from the last purge that FINISHED before the request was
// sent (so a purge is never missed) up to the generation the upstream had when
// the response arrived (so nothing comes from the future). Every response body
// is rebuilt for the generation it claims (X-Gen) and compared byte for byte.
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const fs = require("fs");
const crypto = require("crypto");
const lib = require("./swap-load-lib");

const BLOT_HOST = process.env.BLOT_HOST || "blot.im";
const PROXY_HOST = process.env.PROXY_HOST || "127.0.0.1";
const STUB_URL = process.env.STUB_URL || "http://127.0.0.1:8090";
const PURGE_URL = process.env.PURGE_URL || "http://127.0.0.1:8077";
const PURGE_MS = parseInt(process.env.PURGE_MS || "500", 10);
const WORKERS = parseInt(process.env.WORKERS || "24", 10);
const MARKS = process.env.MARKS || "";
const UA = "Mozilla/5.0 (compatible; swap-load-e2e)";

const BLOG_HOSTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => `b${i}.${BLOT_HOST}`);
const PAGE_HOSTS = [...BLOG_HOSTS, BLOT_HOST];
const PAGES = ["/", ...Array.from({ length: 10 }, (_, i) => `/p/${i + 1}`)];
const LARGE = "/large/1";

// A connection that was opened for this request and reset before a response
// byte: what the kernel does to one that had finished its handshake in the
// listen queue of a socket that was then closed (a container stopping), unless
// net.ipv4.tcp_migrate_req=1 hands it to the other listener (swap-load.sh).
const isHandshakeReset = (e) => e.code === "ECONNRESET" && !e.reusedSocket && !e.gotResponse;
const ALLOW_RESETS = process.env.ALLOW_RESETS === "1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// ---- HTTP ---------------------------------------------------------------

const keepAlive = new https.Agent({ keepAlive: true, maxSockets: 8 });

// Connections that were already open when a request is sent on them and then
// reset or closed before any response byte: the race every HTTP client
// retries on a new connection (RFC 9110 9.2.2) for a GET or HEAD, and that
// a container being stopped makes certain to happen to some. They are counted,
// not hidden: see `keepAliveRetries` in the summary.
const races = { keepAliveRetries: 0 };

function request(options) {
  return attempt(options).catch((e) => {
    if (options.reuse && e.reusedSocket && !e.gotResponse && (options.method || "GET") !== "POST") {
      races.keepAliveRetries++;
      return attempt({ ...options, reuse: false });
    }
    throw e;
  });
}

function attempt({ method = "GET", host, path, headers = {}, body, reuse = false, timeout = 30000 }) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let reused = false;
    let gotResponse = false;
    const fail = (e) => reject(Object.assign(e, { reusedSocket: reused, gotResponse }));
    const r = https.request(
      {
        method,
        host: PROXY_HOST,
        port: 443,
        path,
        servername: host,
        rejectUnauthorized: false,
        agent: reuse ? keepAlive : false,
        headers: { Host: host, "User-Agent": UA, ...headers },
      },
      (res) => {
        gotResponse = true;
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), ms: Date.now() - started, complete: res.complete })
        );
        res.on("error", fail);
        res.on("aborted", () => fail(Object.assign(new Error("response aborted"), { code: "ABORTED" })));
      }
    );
    r.on("socket", (socket) => {
      reused = r.reusedSocket === true;
    });
    r.setTimeout(timeout, () => r.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    r.on("error", fail);
    r.end(body);
  });
}

function plain(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const r = http.request(url, { method, agent: false, timeout: 10000 }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", reject);
    r.end();
  });
}

const stubGen = async (host) => parseInt((await plain(`${STUB_URL}/__gen?host=${host}`)).body, 10);
const stubBump = async (host) => parseInt((await plain(`${STUB_URL}/__gen?host=${host}`, "POST")).body, 10);

// Decode what the proxy sent, as a client that asked for it would
function decode(res) {
  const enc = (res.headers["content-encoding"] || "").toLowerCase();
  if (enc === "gzip") return zlib.gunzipSync(res.body);
  if (enc === "br") return zlib.brotliDecompressSync(res.body);
  if (enc === "" || enc === "identity") return res.body;
  throw new Error("unexpected content-encoding " + enc);
}

// One purge, as Node's helper/flushCache.js sends it (GET /purge?host=H), retried
// the way it is: a proxy answers 503 until it has rebuilt its purge
// index, and the connection to a container being stopped can fail
async function purge(host, stats) {
  for (let attempt = 1; attempt <= 40; attempt++) {
    try {
      const res = await plain(`${PURGE_URL}/purge?host=${encodeURIComponent(host)}`);
      if (res.status === 200) return attempt;
      if (stats) stats.purgeRetries++;
    } catch (e) {
      if (stats) stats.purgeRetries++;
    }
    await sleep(250);
  }
  return 0;
}

// ---- the load -----------------------------------------------------------

async function load() {
  const state = new Map(); // host -> { lo, hi }
  for (const h of PAGE_HOSTS) {
    const g = await stubGen(h);
    state.set(h, { lo: g, hi: g });
  }
  const stats = {
    requests: 0,
    byKind: {},
    cache: {},
    purges: 0,
    purgeRetries: 0,
    purgeFailures: 0,
    keepAliveRetries: 0,
    sse: 0,
    maxMs: 0,
    startedAt: Date.now(),
  };
  const problems = { error: [], status: [], wrong: [], stale: [], sse: [], purge: [], reset: [] };
  const counts = { error: 0, status: 0, wrong: 0, stale: 0, sse: 0, purge: 0, reset: 0 };
  const staleTimes = [];
  const problem = (type, detail) => {
    counts[type]++;
    if (type === "stale") staleTimes.push(Date.now());
    if (problems[type].length < 15) problems[type].push({ at: Date.now(), ...detail });
  };
  let stopping = false;

  // At most ~4.5 requests a second to one blog host: the proxy rate-limits a
  // host (hostlimit, 10/s with a burst of 30), which is not what is tested here
  const slots = new Map();
  const slot = async (host) => {
    if (host === BLOT_HOST) return;
    const at = Math.max(Date.now(), slots.get(host) || 0);
    slots.set(host, at + 220);
    if (at > Date.now()) await sleep(at - Date.now());
  };

  const largeCache = new Map();
  const largeFor = (host, gen) => {
    const k = `${host}|${gen}`;
    if (!largeCache.has(k)) {
      if (largeCache.size > 8) largeCache.delete(largeCache.keys().next().value);
      largeCache.set(k, lib.largeBody(host, LARGE, gen));
    }
    return largeCache.get(k);
  };

  const noteCache = (res) => {
    const c = res.headers["blot-cache"] || "none";
    stats.cache[c] = (stats.cache[c] || 0) + 1;
    return c;
  };

  // The range of generations the response may be from; null if the request
  // is not for a host with a purge cycle
  const bounds = (host) => ({ lo: state.get(host).lo });
  const upper = (host) => state.get(host).hi;

  // Check status 200 + a body that is the page/large file of the generation
  // its X-Gen names, within [lo, hi]. Returns { gen, cache } or null (problem noted).
  function checkBody(kind, host, path, lo, res, body) {
    if (res.status !== 200) {
      problem("status", { kind, host, path, status: res.status, cache: res.headers["blot-cache"] });
      return null;
    }
    const gen = parseInt(res.headers["x-gen"], 10);
    if (!(gen >= 1)) {
      problem("wrong", { kind, host, path, why: "no X-Gen", body: body.slice(0, 80).toString() });
      return null;
    }
    const expected = lib.bodyFor(host, path, gen);
    if (!body.equals(expected) || lib.sha256(body) !== res.headers["x-sum"]) {
      problem("wrong", { kind, host, path, why: "body differs from the upstream's for X-Gen " + gen, got: body.length, expected: expected.length, head: body.slice(0, 100).toString() });
      return null;
    }
    if (gen > upper(host)) {
      problem("wrong", { kind, host, path, why: `generation ${gen} has not been made yet (upstream at ${upper(host)})` });
      return null;
    }
    if (gen < lo) {
      problem("stale", { kind, host, path, gen, purgedGen: lo, cache: res.headers["blot-cache"], server: res.headers["blot-server"] });
      return null;
    }
    return { gen, cache: res.headers["blot-cache"] };
  }

  const encodings = [undefined, "gzip", "gzip, br"];

  const kinds = {
    async page(reuse) {
      const host = pick(PAGE_HOSTS);
      const path = pick(PAGES);
      await slot(host);
      const { lo } = bounds(host);
      const res = await request({ host, path, reuse, headers: { "Accept-Encoding": pick(encodings) || "identity" } });
      noteCache(res);
      checkBody("page", host, path, lo, res, decode(res));
      return res;
    },
    async head(reuse) {
      const host = pick(BLOG_HOSTS);
      const path = pick(PAGES);
      await slot(host);
      const { lo } = bounds(host);
      const res = await request({ method: "HEAD", host, path, reuse });
      noteCache(res);
      const gen = parseInt(res.headers["x-gen"], 10);
      if (res.status !== 200 || res.body.length) problem("status", { kind: "head", host, path, status: res.status, body: res.body.length });
      else if (!(gen >= lo && gen <= upper(host))) problem(gen < lo ? "stale" : "wrong", { kind: "head", host, path, gen, purgedGen: lo });
      return res;
    },
    async conditional(reuse) {
      const host = pick(BLOG_HOSTS);
      const path = pick(PAGES);
      await slot(host);
      let { lo } = bounds(host);
      const first = await request({ host, path, reuse });
      noteCache(first);
      const got = checkBody("conditional-first", host, path, lo, first, first.body);
      if (!got || !first.headers.etag) return first;
      await slot(host);
      lo = bounds(host).lo;
      const res = await request({ host, path, reuse, headers: { "If-None-Match": first.headers.etag } });
      noteCache(res);
      if (res.status === 304) {
        const gen = lib.genOfEtag(res.headers.etag);
        if (res.body.length || gen === null || gen > upper(host)) problem("wrong", { kind: "conditional", host, path, etag: res.headers.etag });
        else if (gen < lo) problem("stale", { kind: "conditional-304", host, path, gen, purgedGen: lo });
      } else {
        checkBody("conditional", host, path, lo, res, decode(res));
      }
      return res;
    },
    async range(reuse) {
      const host = pick(BLOG_HOSTS);
      await slot(host);
      const { lo } = bounds(host);
      const size = 64 * 40960;
      const a = Math.floor(Math.random() * (size - 5000));
      const b = a + 1 + Math.floor(Math.random() * 4000);
      const res = await request({ host, path: LARGE, reuse, headers: { Range: `bytes=${a}-${b}` } });
      noteCache(res);
      if (res.status !== 206 && res.status !== 200) {
        problem("status", { kind: "range", host, path: LARGE, status: res.status });
        return res;
      }
      const slice = res.status === 206 ? [a, b + 1] : [0, size];
      if (res.status === 206 && !new RegExp(`^bytes ${a}-${b}/${size}$`).test(res.headers["content-range"] || "")) {
        problem("wrong", { kind: "range", host, why: "content-range " + res.headers["content-range"], wanted: `${a}-${b}` });
        return res;
      }
      // the slice must be that of some generation between the last purge and now
      const hi = upper(host);
      let matched = 0;
      for (let g = hi; g >= Math.max(1, lo - 2); g--) {
        if (largeFor(host, g).subarray(slice[0], slice[1]).equals(res.body)) {
          matched = g;
          break;
        }
      }
      if (!matched) problem("wrong", { kind: "range", host, status: res.status, got: res.body.length, range: [a, b], x_gen: res.headers["x-gen"] });
      else if (matched < lo) problem("stale", { kind: "range", host, gen: matched, purgedGen: lo });
      return res;
    },
    async large(reuse) {
      const host = pick(BLOG_HOSTS);
      await slot(host);
      const { lo } = bounds(host);
      const res = await request({ host, path: LARGE, reuse });
      noteCache(res);
      checkBody("large", host, LARGE, lo, res, res.body);
      return res;
    },
    async slow(reuse) {
      const host = pick(BLOG_HOSTS);
      const path = "/slow/" + (300 + Math.floor(Math.random() * 400));
      await slot(host);
      const { lo } = bounds(host);
      const res = await request({ host, path, reuse });
      noteCache(res);
      checkBody("slow", host, path, lo, res, res.body);
      return res;
    },
    async random(reuse) {
      const host = pick(BLOG_HOSTS);
      await slot(host);
      const res = await request({ host, path: "/random", reuse });
      const c = noteCache(res);
      let ok = res.status === 200 && c !== "HIT";
      try {
        ok = ok && JSON.parse(res.body.toString()).path === "/random";
      } catch (e) {
        ok = false;
      }
      if (!ok) problem("wrong", { kind: "random", host, status: res.status, cache: c, body: res.body.slice(0, 80).toString() });
      return res;
    },
    async post() {
      const size = pick([0, 100, 4096, 65536, 1 << 20, 5 << 20, 24 << 20]);
      const off = Math.floor(Math.random() * 1000);
      const body = POST_DATA.subarray(off, off + size);
      const res = await request({ method: "POST", host: BLOT_HOST, path: "/sites/e2e/upload", body, headers: { "Content-Type": "application/octet-stream", "Content-Length": body.length }, timeout: 60000 }).catch((e) => {
        throw Object.assign(e, { size });
      });
      noteCache(res);
      let ok = res.status === 200;
      try {
        const j = JSON.parse(res.body.toString());
        ok = ok && j.len === body.length && j.sha256 === crypto.createHash("sha256").update(body).digest("hex");
      } catch (e) {
        ok = false;
      }
      if (!ok) problem("wrong", { kind: "post", size, status: res.status, body: res.body.slice(0, 120).toString() });
      return res;
    },
  };
  const POST_DATA = crypto.randomBytes((24 << 20) + 1000);
  const mix = [["page", 40], ["head", 5], ["conditional", 6], ["range", 9], ["large", 3], ["slow", 4], ["random", 5], ["post", 8]];
  const total = mix.reduce((n, [, w]) => n + w, 0);
  const choose = () => {
    let r = Math.random() * total;
    for (const [k, w] of mix) if ((r -= w) < 0) return k;
    return "page";
  };

  async function worker(i) {
    const reuse = i % 2 === 0;
    while (!stopping) {
      const kind = choose();
      const t0 = Date.now();
      stats.requests++;
      stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
      try {
        const res = await kinds[kind](reuse);
        stats.maxMs = Math.max(stats.maxMs, res.ms);
      } catch (e) {
        if (isHandshakeReset(e)) problem("reset", { kind, size: e.size, ms: Date.now() - t0 });
        else problem("error", { kind, error: e.code || e.message, syscall: e.syscall, reused: e.reusedSocket, gotResponse: e.gotResponse, ms: Date.now() - t0, size: e.size });
      }
      await sleep(20 + Math.random() * 60);
    }
  }

  // A status stream the swap must not cut: 30 events, 6 s, then `done`
  async function sse() {
    while (!stopping) {
      stats.sse++;
      const started = Date.now();
      try {
        const res = await request({ host: BLOT_HOST, path: "/sites/e2e/status", reuse: false, timeout: 30000 });
        const text = res.body.toString();
        const events = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: done").map((l) => l.slice(6));
        const ok = res.status === 200 && events.length === lib.SSE_EVENTS && events.every((e, i) => e === String(i + 1)) && text.endsWith("event: done\ndata: done\n\n");
        if (!ok) problem("sse", { status: res.status, events: events.length, ms: Date.now() - started });
      } catch (e) {
        if (isHandshakeReset(e)) problem("reset", { kind: "sse", ms: Date.now() - started });
        else problem("sse", { error: e.code || e.message, ms: Date.now() - started });
      }
    }
  }

  // A purge about every PURGE_MS, as Node does after an edit: the page changes,
  // then the proxy is told
  async function purger() {
    let i = 0;
    while (!stopping) {
      const host = PAGE_HOSTS[i++ % PAGE_HOSTS.length];
      const s = state.get(host);
      s.hi++;
      const gen = await stubBump(host);
      if (gen !== s.hi) problem("wrong", { kind: "stub", why: `generation ${gen}, expected ${s.hi}` });
      const attempts = await purge(host, stats);
      if (attempts) {
        s.lo = Math.max(s.lo, gen);
        stats.purges++;
      } else {
        stats.purgeFailures++;
        problem("purge", { host, gen });
      }
      await sleep(PURGE_MS);
    }
  }

  const tasks = [purger(), sse(), sse(), ...Array.from({ length: WORKERS }, (_, i) => worker(i))];
  if (process.env.READY_FILE) fs.writeFileSync(process.env.READY_FILE, "ready\n");
  await new Promise((resolve) => {
    const stop = () => {
      stopping = true;
      resolve();
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  });
  await Promise.all(tasks);

  // A page older than a purge that had finished, while both containers were
  // up: the limitation documented in blue-green.sh. A purge reaches one of the
  // two containers, each keeps the list of what to delete in its own memory,
  // and a page one of them cached after the other rebuilt its list is unknown
  // to the other. The driver marks that window (from when the new container
  // started until the old one had stopped); a stale answer inside it is counted
  // apart, one outside it is a failure like any other. ALLOW_OVERLAP_STALE=1
  // tolerates those.
  let marks = [];
  try {
    marks = fs.readFileSync(MARKS, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(" "));
  } catch (e) {}
  const windows = [];
  for (let i = 0; i + 1 < marks.length; i += 2) windows.push([parseInt(marks[i][1], 10), parseInt(marks[i + 1][1], 10)]);
  const inWindow = (t) => windows.some(([a, b]) => t >= a - 1500 && t <= b + 1500);
  const staleInWindow = process.env.ALLOW_OVERLAP_STALE === "1" ? staleTimes.filter(inWindow).length : 0;
  counts.stale -= staleInWindow;

  const resets = counts.reset;
  if (ALLOW_RESETS) counts.reset = 0;
  const failures = counts.error + counts.status + counts.wrong + counts.stale + counts.sse + counts.purge + counts.reset;
  stats.keepAliveRetries = races.keepAliveRetries;
  const summary = { ...stats, seconds: Math.round((Date.now() - stats.startedAt) / 1000), counts, staleInOverlap: staleInWindow, handshakeResets: resets, problems: failures || staleInWindow || resets ? problems : undefined };
  console.log(JSON.stringify(summary, null, 1));
  process.exit(failures ? 1 : 0);
}

// ---- single requests --------------------------------------------------------

async function one(host, path) {
  const res = await request({ host, path });
  const gen = parseInt(res.headers["x-gen"], 10);
  return { status: res.status, gen, cache: res.headers["blot-cache"], body: res.body, headers: res.headers };
}

const settle = () => sleep(250); // a miss is published just after the response ends

async function main() {
  const [cmd, host, path] = process.argv.slice(2);
  const fail = (msg) => {
    console.error("FAIL:", msg);
    process.exit(1);
  };
  if (cmd === "load") return load();
  if (cmd === "warm") {
    for (const h of PAGE_HOSTS) {
      for (const p of [...PAGES, LARGE]) {
        let r;
        for (let tries = 0; tries < 3; tries++) {
          r = await one(h, p);
          await settle();
          if (r.status === 200 && r.cache === "HIT") break;
        }
        if (r.status !== 200 || r.cache !== "HIT") fail(`${h}${p} was not a HIT after warming (status ${r.status}, cache ${r.cache})`);
      }
    }
    console.log(`warmed ${PAGE_HOSTS.length * (PAGES.length + 1)} pages`);
    return;
  }
  if (cmd === "verify-all") {
    // after the load has stopped, every change was followed by a purge: no
    // page, cached or not, may be from an older generation than the upstream's
    let n = 0;
    for (const h of PAGE_HOSTS) {
      const gen = await stubGen(h);
      for (const p of [...PAGES, LARGE]) {
        const r = await one(h, p);
        if (r.status !== 200) fail(`${h}${p} answered ${r.status}`);
        if (!r.body.equals(lib.bodyFor(h, p, r.gen))) fail(`${h}${p}: body does not match the upstream's for generation ${r.gen}`);
        if (r.gen !== gen) fail(`${h}${p}: generation ${r.gen} served, the upstream is at ${gen}: STALE (cache ${r.cache})`);
        n++;
      }
    }
    console.log(`verified ${n} pages: all of the upstream's current generation`);
    return;
  }
  if (cmd === "get") {
    const r = await one(host, path);
    console.log(r.status, r.gen, r.cache);
    return;
  }
  if (cmd === "bump") {
    console.log(await stubBump(host));
    return;
  }
  if (cmd === "change") {
    // what Node does after an edit: the page changes, then the proxy is told
    const gen = await stubBump(host);
    if (!(await purge(host))) fail("the purge was refused");
    console.log(gen);
    return;
  }
  if (cmd === "hit" || cmd === "fresh") {
    const r = await one(host, path);
    const gen = await stubGen(host);
    if (r.status !== 200) fail(`${host}${path} answered ${r.status}`);
    if (!r.body.equals(lib.bodyFor(host, path, r.gen))) fail(`${host}${path}: body does not match the upstream's for generation ${r.gen}`);
    if (r.gen !== gen) fail(`${host}${path}: generation ${r.gen} served, the upstream is at ${gen}: STALE (cache ${r.cache})`);
    if (cmd === "hit" && r.cache !== "HIT") fail(`${host}${path}: expected a HIT, got ${r.cache}`);
    console.log(`${host}${path}: generation ${r.gen}, ${r.cache}`);
    return;
  }
  if (cmd === "purge-works") {
    const p = "/p/1";
    for (let i = 0; i < 2; i++) {
      await one(host, p);
      await settle();
    }
    const before = await one(host, p);
    if (before.cache !== "HIT") fail(`${host}${p} was not a HIT before the purge (${before.cache})`);
    const gen = await stubBump(host);
    if (!(await purge(host))) fail("the purge was refused");
    const after = await one(host, p);
    if (after.status !== 200 || after.cache !== "MISS" || after.gen !== gen) fail(`${host}${p} after a purge: status ${after.status}, ${after.cache}, generation ${after.gen}; wanted a MISS of generation ${gen}`);
    await settle();
    const again = await one(host, p);
    if (again.cache !== "HIT" || again.gen !== gen) fail(`${host}${p} after the refill: ${again.cache}, generation ${again.gen}; wanted a HIT of generation ${gen}`);
    console.log(`purge works: ${host}${p} HIT, then after the purge MISS and HIT of generation ${gen}`);
    return;
  }
  if (cmd === "fill" || cmd === "change-fill" || cmd === "check-fill") {
    const prefix = host;
    const hosts = [1, 2, 3, 4, 5, 6].map((i) => `${prefix}${i}.${BLOT_HOST}`);
    const file = process.env.FILL_FILE;
    if (!file) fail("FILL_FILE is not set");
    if (cmd === "change-fill") {
      for (const h of hosts) {
        await stubBump(h);
        if (!(await purge(h))) fail(`the purge of ${h} was refused`);
      }
      console.log(`changed and purged ${hosts.length} hosts`);
      return;
    }
    if (cmd === "check-fill") {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      const gens = new Map();
      let stale = 0;
      let wrong = 0;
      const sample = [];
      for (const line of lines) {
        const [h, p] = line.split(" ");
        if (!gens.has(h)) gens.set(h, await stubGen(h));
        const r = await one(h, p);
        if (r.status !== 200 || !r.body.equals(lib.bodyFor(h, p, r.gen))) wrong++;
        else if (r.gen !== gens.get(h)) {
          stale++;
          if (sample.length < 5) sample.push(`${h}${p} gen ${r.gen} (upstream ${gens.get(h)}, ${r.cache})`);
        }
      }
      console.log(`${lines.length} pages checked: ${stale} stale, ${wrong} wrong or failed` + (sample.length ? `; e.g. ${sample.join("; ")}` : ""));
      process.exit(stale || wrong ? 2 : 0);
    }
    let stopping = false;
    process.on("SIGTERM", () => (stopping = true));
    process.on("SIGINT", () => (stopping = true));
    fs.writeFileSync(file, "");
    let n = 0;
    await Promise.all(
      hosts.map(async (h) => {
        while (!stopping) {
          const p = `/ov/${++n}`;
          try {
            const r = await request({ host: h, path: p });
            if (r.status === 200) fs.appendFileSync(file, `${h} ${p}\n`);
          } catch (e) {}
          await sleep(120);
        }
      })
    );
    return;
  }
  fail("unknown command " + cmd);
}

main().catch((e) => {
  console.error("FAIL:", e.stack || e);
  process.exit(1);
});
