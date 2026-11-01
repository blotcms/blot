// Behavioural checks for the disk cache (proxy/config/diskcache.lua and
// proxy/evict.sh) against the REAL proxy image with the generated production
// config. Plain node, no dependencies. Run by the proxy-matrix job in
// .github/workflows/integration.yml after the image is built:
//
//   docker build -f proxy/Dockerfile -t blot-proxy:e2e proxy/
//   node proxy/e2e/diskcache-checks.js
//
// It starts its own containers (names prefixed dc-), each with the stub
// upstream (proxy/e2e/stub-upstream.js) in its network namespace:
//
//   dc-a, dc-b  two proxies sharing one cache volume, as two blue/green
//               instances do on the host
//   dc-t        a proxy started with BLOT_PURGE_TOKEN=secret
//   dc-rl       a proxy whose rate limits are left on
//
// and removes them (and their volumes) at the end. Environment:
//
//   PROXY_IMAGE   image to test              (default blot-proxy:e2e)
//   DC_PORT_BASE  first of the host ports used (default 18080)
//
// Every section uses its own host name, so one section's cache entries and
// rate-limit state cannot leak into another. The rate limits (6 requests a
// second a client) would slow a script that makes hundreds of requests from
// one address, so dc-a, dc-b and dc-t put every address on the whitelist
// (the same geo block the Bunny edges are on) and reload; dc-rl does not.

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const IMAGE = process.env.PROXY_IMAGE || "blot-proxy:e2e";
const BASE = parseInt(process.env.DC_PORT_BASE || "18080", 10);
const STUB = path.join(__dirname, "stub-upstream.js");
const CACHE = "/var/cache/openresty";

// The shared-cache pair, the token container and the rate-limit container.
// `http` is the port the container's port 80 is published on.
const A = { name: "dc-a", http: BASE, https: BASE + 1, volume: "dc-cache-shared" };
const B = { name: "dc-b", http: BASE + 2, volume: "dc-cache-shared" };
const T = { name: "dc-t", http: BASE + 3, volume: "dc-cache-token", env: ["BLOT_PURGE_TOKEN=secret"] };
const RL = { name: "dc-rl", http: BASE + 4, volume: "dc-cache-rl", limited: true };
const ALL = [A, B, T, RL];

let passes = 0;
let failures = 0;
const failed = [];
const started = Date.now();

function check(name, cond, detail) {
  if (cond) {
    passes++;
    console.log("  ok  -", name);
  } else {
    failures++;
    failed.push(name);
    console.log("  FAIL -", name, detail === undefined ? "" : "->  " + detail);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, timeoutMs = 10000, everyMs = 200) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) return value;
    await sleep(everyMs);
  }
}

// ---- docker -------------------------------------------------------------

function docker(...args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function dockerTry(...args) {
  try {
    return docker(...args);
  } catch (e) {
    return (e.stdout || "") + (e.stderr || "");
  }
}

// Run a shell snippet in a container, as root unless `user` is given
function sh(c, script, user) {
  const args = user ? ["exec", "-u", user] : ["exec"];
  return docker(...args, c.name || c, "sh", "-c", script);
}

function shTry(c, script) {
  try {
    return sh(c, script);
  } catch (e) {
    return (e.stdout || "") + (e.stderr || "");
  }
}

function cleanup() {
  for (const c of ALL) {
    dockerTry("rm", "-f", c.name + "-stub", c.name);
  }
  for (const v of new Set(ALL.map((c) => c.volume))) dockerTry("volume", "rm", "-f", v);
}

async function startProxy(c) {
  const args = ["run", "-d", "--name", c.name, "-p", `${c.http}:80`];
  if (c.https) args.push("-p", `${c.https}:443`);
  args.push("-e", "BLOT_HOST=localhost", "-e", "PROXY_UNIT_MAIN=127.0.0.1:8090", "-e", "PROXY_UNIT_WORKER=127.0.0.1:8089", "-e", "PROXY_PEER_MAIN=127.0.0.1:8088", "-e", "PROXY_PEER_WORKER=127.0.0.1:8088", "-v", `${c.volume}:${CACHE}`);
  for (const e of c.env || []) args.push("-e", e);
  docker(...args, IMAGE);

  // the stub shares the proxy's network namespace, as in the CI job
  docker("run", "-d", "--name", c.name + "-stub", "--network", "container:" + c.name, "-v", `${STUB}:/s.js:ro`, "node:24.22.1-alpine", "node", "/s.js");

  const stubUp = await waitFor(() => {
    try {
      sh(c, "wget -qO- -T1 http://127.0.0.1:8090/ >/dev/null 2>&1");
      return true;
    } catch (e) {
      return false;
    }
  }, 40000, 500);
  if (!stubUp) throw new Error(c.name + ": stub upstream did not come up");

  const proxyUp = await waitFor(async () => (await req(c, "ready.example", "/health").catch(() => ({}))).status === 200, 40000, 500);
  if (!proxyUp) throw new Error(c.name + ": proxy did not come up\n" + dockerTry("logs", c.name));

  if (!c.limited) {
    // every address on the geo whitelist (http.conf): no per-client rate or
    // connection limits. The reload also shows the cache survives one.
    sh(c, "printf '0.0.0.0/0 1;\\n::/0 1;\\n' > /etc/openresty/cdn-ips.conf && /usr/local/openresty/bin/openresty -s reload");
    await sleep(1500);
  }
}

// Number of requests the stub in this container has seen for a path
function nodeCount(c, p) {
  return parseInt(sh(c, `wget -qO- -T2 'http://127.0.0.1:8088/__count?path=${p}'`).trim(), 10);
}

// ---- requests -----------------------------------------------------------

// One request. Resolves with { status, headers (lower case), body (Buffer), ms }.
// No redirects followed, no decompression: the bytes the proxy sent.
function req(c, host, p, { method = "GET", headers = {}, tls = false, body } = {}) {
  const started = Date.now();
  const mod = tls ? https : http;
  const options = {
    method,
    host: "127.0.0.1",
    port: tls ? c.https : c.http,
    path: p,
    agent: false,
    headers: { Host: host, "User-Agent": "Mozilla/5.0 (compatible; diskcache-checks)", ...headers },
    rejectUnauthorized: false,
    servername: tls ? host : undefined,
    timeout: 30000,
  };
  return new Promise((resolve, reject) => {
    const r = mod.request(options, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks), ms: Date.now() - started })
      );
      res.on("error", reject);
    });
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", reject);
    r.end(body);
  });
}

const cacheStatus = (r) => r.headers["blot-cache"];

// A miss publishes in log_by_lua, just after the response ends: give it a
// moment before the next request
async function settle(ms = 150) {
  await sleep(ms);
}

// ---- cache files --------------------------------------------------------

const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");

// <a>/<bc>/<host>, as host_path() in diskcache.lua
function hostDir(host) {
  const h = md5(host);
  return `${h.slice(-1)}/${h.slice(-3, -1)}/${host}`;
}

// The key a request has: md5($scheme://$host$request_uri)
const keyOf = (host, p, scheme = "http") => md5(`${scheme}://${host}${p}`);

function files(c, host) {
  return shTry(c, `ls -A ${CACHE}/${hostDir(host)} 2>/dev/null`).split("\n").filter(Boolean);
}

function entry(c, host, p, scheme) {
  const key = keyOf(host, p, scheme);
  const all = files(c, host);
  return {
    key,
    meta: all.includes(key + ".meta"),
    body: all.find((f) => f.startsWith(key + ".") && !f.endsWith(".meta") && !f.endsWith(".br")),
    br: all.find((f) => f.startsWith(key + ".") && f.endsWith(".br")),
  };
}

function purge(c, hosts, token) {
  const query = hosts.map((h) => "host=" + h).join("&");
  const header = token === undefined ? "" : `-H 'X-Blot-Purge-Token: ${token}'`;
  const out = sh(c, `curl -s -m 10 -w '\\n%{http_code}' ${header} 'http://127.0.0.1/purge?${query}'`);
  const lines = out.trimEnd().split("\n");
  return { code: parseInt(lines.pop(), 10), text: lines.join("\n") };
}

function plain(r) {
  return r.headers["content-encoding"] ? null : r.body;
}

// ---- sections -----------------------------------------------------------

async function basicBlogAndSite() {
  console.log("blog host and site host: miss then hit");
  const host = "basic.example";
  const m = await req(A, host, "/page");
  await settle();
  const h = await req(A, host, "/page");
  check("blog: first request is a MISS", cacheStatus(m) === "MISS" && m.status === 200, cacheStatus(m));
  check("blog: second request is a HIT", cacheStatus(h) === "HIT" && h.status === 200, cacheStatus(h));
  check("blog: hit body identical to the miss", m.body.equals(h.body));
  const e = entry(A, host, "/page");
  check("blog: .meta and body file are on disk", e.meta && !!e.body, JSON.stringify(files(A, host)));
  check("blog: Node was asked once", nodeCount(A, "/page") === 1);

  const sm = await req(A, "localhost", "/some-cacheable-page", { tls: true });
  await settle();
  const sh2 = await req(A, "localhost", "/some-cacheable-page", { tls: true });
  check("site (localhost over https): MISS", cacheStatus(sm) === "MISS" && sm.status === 200, `${sm.status} ${cacheStatus(sm)}`);
  check("site (localhost over https): then HIT", cacheStatus(sh2) === "HIT" && sh2.body.equals(sm.body), cacheStatus(sh2));
  check("site: entry on disk", entry(A, "localhost", "/some-cacheable-page", "https").meta);
}

async function brotli() {
  console.log("brotli copies and content negotiation");
  const host = "br.example";
  const p = "/compress-me";
  const m = await req(A, host, p);
  await settle();
  check("miss without Accept-Encoding is MISS", cacheStatus(m) === "MISS");
  await sleep(1500); // longer than the compressor's poll
  check("no .br after the miss alone", !entry(A, host, p).br, JSON.stringify(files(A, host)));

  const h = await req(A, host, p);
  check("first hit is plain and HIT", cacheStatus(h) === "HIT" && !h.headers["content-encoding"], JSON.stringify(h.headers));
  check("plain hit body equals the miss body", h.body.equals(m.body));
  const br = await waitFor(() => entry(A, host, p).br, 15000);
  check(".br appears after the first hit", !!br);
  await settle(300);

  const rb = await req(A, host, p, { headers: { "Accept-Encoding": "br" } });
  check("br client gets Content-Encoding: br", rb.headers["content-encoding"] === "br", rb.headers["content-encoding"]);
  let decoded;
  try {
    decoded = zlib.brotliDecompressSync(rb.body);
  } catch (e) {
    decoded = Buffer.alloc(0);
  }
  check("br body decompresses to the plain body", decoded.equals(m.body));
  check("br response is smaller than the plain one", rb.body.length < m.body.length);
  check("br response Vary: Accept-Encoding", /accept-encoding/i.test(rb.headers.vary || ""), rb.headers.vary);

  const rg = await req(A, host, p, { headers: { "Accept-Encoding": "gzip" } });
  check("gzip-only client gets gzip", rg.headers["content-encoding"] === "gzip", rg.headers["content-encoding"]);
  let gunzipped;
  try {
    gunzipped = zlib.gunzipSync(rg.body);
  } catch (e) {
    gunzipped = Buffer.alloc(0);
  }
  check("gzip body gunzips to the plain body", gunzipped.equals(m.body));
  check("gzip response Vary: Accept-Encoding", /accept-encoding/i.test(rg.headers.vary || ""), rg.headers.vary);

  const rn = await req(A, host, p);
  check("client with no Accept-Encoding gets the plain body", !rn.headers["content-encoding"] && rn.body.equals(m.body));
  check("plain response Vary: Accept-Encoding", /accept-encoding/i.test(rn.headers.vary || ""), rn.headers.vary);

  const r0 = await req(A, host, p, { headers: { "Accept-Encoding": "br;q=0" } });
  check("br;q=0 does not get br", r0.headers["content-encoding"] !== "br", r0.headers["content-encoding"]);
  check("br;q=0 body is usable", r0.headers["content-encoding"] ? true : r0.body.equals(m.body));

  // images are not worth a copy
  const png = "/pic.png";
  await req(A, host, png);
  await settle();
  const ph = await req(A, host, png);
  await sleep(2500);
  const pe = entry(A, host, png);
  check("image: MISS then HIT", cacheStatus(ph) === "HIT" && pe.meta);
  check("image never gets a .br", !pe.br, JSON.stringify(files(A, host)));

  // A miss from a client that accepts br stores Node's plain body
  const host2 = "brmiss.example";
  const mb = await req(A, host2, p, { headers: { "Accept-Encoding": "br, gzip" } });
  await settle();
  const hn = await req(A, host2, p);
  const e2 = entry(A, host2, p);
  const stored = e2.body ? sh(A, `cat ${CACHE}/${hostDir(host2)}/${e2.body}`) : null;
  let missPlain;
  try {
    missPlain = mb.headers["content-encoding"] === "br" ? zlib.brotliDecompressSync(mb.body) : mb.body;
  } catch (e) {
    missPlain = Buffer.alloc(0);
  }
  check("br-accepting miss: MISS", cacheStatus(mb) === "MISS");
  check("then a client accepting nothing gets a plain HIT", cacheStatus(hn) === "HIT" && !hn.headers["content-encoding"]);
  check("that plain hit has the same content as the miss", hn.body.equals(missPlain));
  check("the stored body is uncompressed", stored !== null && Buffer.from(stored).equals(hn.body));
}

async function etag() {
  console.log("ETag and conditional requests");
  const host = "etag.example";
  const p = "/etag-page";
  const node = '"node-etag-1"';
  const m = await req(A, host, p);
  await settle();
  check("miss carries Node's ETag", m.headers.etag === node, m.headers.etag);
  const h = await req(A, host, p);
  check("hit sends Node's ETag as Node sent it (strong), as proxy_cache did", cacheStatus(h) === "HIT" && h.headers.etag === node, h.headers.etag);
  check("hit of a page Node sent without Last-Modified has none", cacheStatus(h) === "HIT" && h.headers["last-modified"] === undefined, h.headers["last-modified"]);

  const strong = await req(A, host, p, { headers: { "If-None-Match": node } });
  check("If-None-Match (strong form) gets 304 on a hit", strong.status === 304, strong.status);
  check("304 has no body", strong.body.length === 0);
  const weakR = await req(A, host, p, { headers: { "If-None-Match": "W/" + node } });
  check("If-None-Match (weak form) gets 304 on a hit", weakR.status === 304, weakR.status);
  const ims = await req(A, host, p, {
    headers: { "If-None-Match": node, "If-Modified-Since": "Mon, 01 Jan 2001 00:00:00 GMT" },
  });
  // nginx's not_modified filter tests If-Modified-Since first, as it did for proxy_cache
  check("old If-Modified-Since with a matching If-None-Match gets the page (200), as with proxy_cache", ims.status === 200, ims.status);
  const other = await req(A, host, p, { headers: { "If-None-Match": '"something-else"' } });
  check("non-matching If-None-Match gets the page", other.status === 200 && other.body.equals(h.body), other.status);

  // the brotli copy shares the validator
  await waitFor(() => entry(A, host, p).br, 15000);
  await settle(300);
  const bc = await req(A, host, p, { headers: { "Accept-Encoding": "br", "If-None-Match": node } });
  check("If-None-Match with a brotli copy present gets 304", bc.status === 304, bc.status);
  const bp = await req(A, host, p, { headers: { "Accept-Encoding": "br" } });
  check("brotli response keeps the weak ETag", bp.headers.etag === "W/" + node, bp.headers.etag);

  // Same content after a purge and refill: the old validator keeps working
  purge(A, [host]);
  await sleep(300);
  const refill = await req(A, host, p);
  await settle();
  check("after a purge the next request is a MISS", cacheStatus(refill) === "MISS", cacheStatus(refill));
  const old = await req(A, host, p, { headers: { "If-None-Match": node } });
  check("old validator gets 304 on the refilled hit", old.status === 304, old.status);
}

async function redirectsAndErrors() {
  console.log("redirects, 404, HEAD, Range, POST");
  const host = "redir.example";
  for (const code of [301, 302]) {
    const p = "/redirect-" + code;
    const m = await req(A, host, p);
    await settle();
    const h = await req(A, host, p);
    check(`${code}: miss and hit have the same status`, m.status === code && h.status === code, `${m.status}/${h.status}`);
    check(`${code}: second request is a HIT`, cacheStatus(m) === "MISS" && cacheStatus(h) === "HIT", `${cacheStatus(m)}/${cacheStatus(h)}`);
    check(`${code}: same Location`, m.headers.location === "/redirect-target" && h.headers.location === m.headers.location, `${m.headers.location}/${h.headers.location}`);
    // the stray Content-Type bug: Lua adds default_type to a response with none
    check(`${code}: hit has the Content-Type the miss had`, h.headers["content-type"] === m.headers["content-type"], `miss=${m.headers["content-type"]} hit=${h.headers["content-type"]}`);
    check(`${code}: no body on either`, m.body.length === 0 && h.body.length === 0);
    check(`${code}: Node asked once`, nodeCount(A, p) === 1);
  }

  const nf = "/notfound-cache-me";
  const nm = await req(A, host, nf);
  await settle();
  const nh = await req(A, host, nf);
  check("404 is cached: second request is a HIT", nm.status === 404 && nh.status === 404 && cacheStatus(nh) === "HIT", `${nm.status} ${cacheStatus(nh)}`);
  check("404 hit has the same body", nh.body.equals(nm.body));
  check("404: Node asked once", nodeCount(A, nf) === 1);

  // HEAD
  const hh = "head.example";
  const hp = "/head-page";
  const hm = await req(A, hh, hp, { method: "HEAD" });
  await settle();
  check("HEAD miss: MISS, no body", cacheStatus(hm) === "MISS" && hm.body.length === 0, cacheStatus(hm));
  check("HEAD miss is not stored", !entry(A, hh, hp).meta, JSON.stringify(files(A, hh)));
  const g = await req(A, hh, hp);
  await settle();
  check("GET after a HEAD miss: MISS with the full body", cacheStatus(g) === "MISS" && g.status === 200 && g.body.length > 500, `${cacheStatus(g)} ${g.body.length}`);
  const hhit = await req(A, hh, hp, { method: "HEAD" });
  check("HEAD hit: headers, no body", cacheStatus(hhit) === "HIT" && hhit.body.length === 0 && Number(hhit.headers["content-length"]) === g.body.length, `${cacheStatus(hhit)} len=${hhit.headers["content-length"]}`);

  // Range
  const rh = "range.example";
  const rp = "/echo-range";
  const rm = await req(A, rh, rp, { headers: { Range: "bytes=0-9" } });
  await settle();
  check("Range on an uncached key: MISS", cacheStatus(rm) === "MISS", `${rm.status} ${cacheStatus(rm)}`);
  const full = await req(A, rh, rp);
  check("the entry was stored: plain GET is a HIT", cacheStatus(full) === "HIT" && full.status === 200, `${full.status} ${cacheStatus(full)}`);
  let seen;
  try {
    seen = JSON.parse(full.body.toString()).range;
  } catch (e) {
    seen = "unparsable";
  }
  check("Node did not receive the Range header (stored body is the whole page)", seen === null, String(seen));
  const rr = await req(A, rh, rp, { headers: { Range: "bytes=0-9" } });
  check("later Range request is a HIT answered 206", rr.status === 206 && cacheStatus(rr) === "HIT", `${rr.status} ${cacheStatus(rr)}`);
  check("206 has the right 10 bytes", rr.body.equals(full.body.subarray(0, 10)), rr.body.toString());
  check("206 Content-Range", rr.headers["content-range"] === `bytes 0-9/${full.body.length}`, rr.headers["content-range"]);

  // POST
  const ph = "post.example";
  const pp = "/post-target";
  const before = nodeCount(A, pp);
  const po = await req(A, ph, pp, { method: "POST", body: "a=b", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  await settle();
  check("POST to a cached location is rejected", po.status === 403, po.status);
  check("POST did not reach Node", nodeCount(A, pp) === before);
  check("POST is not cached", !entry(A, ph, pp).meta);
  const pg = await req(A, ph, pp);
  check("GET after a rejected POST is a normal MISS", pg.status === 200 && cacheStatus(pg) === "MISS", `${pg.status} ${cacheStatus(pg)}`);

  // Errors: not cached, and the fill lock is not left held
  console.log("upstream errors");
  const eh = "err.example";
  const c0 = nodeCount(A, "/boom");
  const e1 = await req(A, eh, "/boom");
  const c1 = nodeCount(A, "/boom");
  const e2 = await req(A, eh, "/boom");
  const c2 = nodeCount(A, "/boom");
  check("500: not cached", !entry(A, eh, "/boom").meta);
  check("500: both requests reached Node", c1 > c0 && c2 > c1, `${c0} ${c1} ${c2}`);
  check("500: second request not delayed by a held fill lock", e1.ms < 2000 && e2.ms < 2000, `${e1.ms}ms ${e2.ms}ms`);
  check("500: status is an error", e1.status >= 500 && e2.status >= 500, `${e1.status} ${e2.status}`);
  const u = await req(A, eh, "/unavailable");
  const u2 = await req(A, eh, "/unavailable");
  check("503 is not cached and not delayed", u.status === 503 && u2.status === 503 && u2.ms < 2000 && !entry(A, eh, "/unavailable").meta, `${u.status} ${u2.ms}ms`);
}

async function purgeChecks() {
  console.log("purge");
  const host = "purge.example";
  const m = await req(A, host, "/p1");
  await req(A, host, "/p2");
  await settle();
  const hb = await req(B, host, "/p1");
  check("fill in A is a HIT in B (shared cache)", cacheStatus(m) === "MISS" && cacheStatus(hb) === "HIT", `${cacheStatus(m)}/${cacheStatus(hb)}`);

  // lots of files, so the removal takes long enough to be seen in .trash
  sh(A, `mkdir -p ${CACHE}/${hostDir(host)}/.tmp && cd ${CACHE}/${hostDir(host)}/.tmp && seq 1 20000 | xargs touch`, "ec2-user");
  const watcher = spawn("docker", ["exec", A.name, "sh", "-c",
    `i=0; while [ $i -lt 20000 ]; do if [ -n "$(ls -A ${CACHE}/.trash 2>/dev/null)" ]; then echo seen; exit; fi; i=$((i+1)); done; echo no`]);
  let watched = "";
  watcher.stdout.on("data", (d) => (watched += d));
  const watchDone = new Promise((r) => watcher.on("close", r));
  await sleep(400);

  const pr = purge(A, [host]);
  check("purge answers 200 and says purged", pr.code === 200 && /purge\.example: purged/.test(pr.text), `${pr.code} ${pr.text}`);
  check("old host directory is gone at once", files(A, host).length === 0, JSON.stringify(files(A, host).slice(0, 5)));
  check("purge marker written", /\.purged$/m.test(shTry(A, `ls ${CACHE}/${hostDir(host).replace(/[^/]*$/, "")}`)));
  await watchDone;
  check("the host directory showed up under .trash", /seen/.test(watched), watched.trim());
  const emptied = await waitFor(() => shTry(A, `ls -A ${CACHE}/.trash`).trim() === "", 30000, 300);
  check(".trash is emptied afterwards", emptied, shTry(A, `ls -A ${CACHE}/.trash`));

  // after the purge, A and B each miss (a different key each, since the
  // first refill would be a hit for the other)
  const ma = await req(A, host, "/p1");
  const mb = await req(B, host, "/p2");
  check("next request in A is a MISS", cacheStatus(ma) === "MISS", cacheStatus(ma));
  check("next request in B is a MISS", cacheStatus(mb) === "MISS", cacheStatus(mb));

  // one host's purge leaves another's entries alone; several hosts at once
  console.log("purge isolation and multiple hosts");
  const hosts = ["iso1.example", "iso2.example", "iso3.example"];
  for (const h of hosts) await req(A, h, "/x");
  await settle();
  purge(A, [hosts[0]]);
  const r1 = await req(B, hosts[0], "/x");
  const r2 = await req(B, hosts[1], "/x");
  const r3 = await req(A, hosts[2], "/x");
  check("purged host is a MISS", cacheStatus(r1) === "MISS", cacheStatus(r1));
  check("another host stays cached (HIT in B)", cacheStatus(r2) === "HIT", cacheStatus(r2));
  check("a third host stays cached (HIT in A)", cacheStatus(r3) === "HIT", cacheStatus(r3));
  const two = purge(A, [hosts[1], hosts[2]]);
  check("one purge naming two hosts answers for both", /iso2\.example: purged/.test(two.text) && /iso3\.example: purged/.test(two.text), two.text);
  const t2 = await req(A, hosts[1], "/x");
  const t3 = await req(B, hosts[2], "/x");
  check("first of the two hosts is a MISS", cacheStatus(t2) === "MISS", cacheStatus(t2));
  check("second of the two hosts is a MISS", cacheStatus(t3) === "MISS", cacheStatus(t3));

  console.log("purge token");
  const bad = [["no token", undefined], ["wrong token, same length", "secrex"], ["different length", "sec"], ["empty token", ""], ["longer token", "secretsecret"]];
  for (const [label, token] of bad) {
    check(`token set, ${label}: 403`, purge(T, ["tok.example"], token).code === 403);
  }
  const good = purge(T, ["tok.example"], "secret");
  check("token set, right token: 200", good.code === 200, good.code);
  check("token unset (dc-a), no token: 200", purge(A, ["tok.example"]).code === 200);
}

async function sharedCache() {
  console.log("two containers sharing the cache");
  // brotli copy made by A's worker after a hit in A, served by both
  let host = "shared1.example";
  let p = "/compress-me";
  await req(A, host, p);
  await settle();
  const hitA = await req(A, host, p);
  check("shared: hit in A", cacheStatus(hitA) === "HIT");
  check("shared: .br appears (made after a hit in A)", !!(await waitFor(() => entry(A, host, p).br, 15000)));
  await settle(300);
  for (const c of [A, B]) {
    const r = await req(c, host, p, { headers: { "Accept-Encoding": "br" } });
    check(`shared: ${c.name} serves the .br made after a hit in A`, r.headers["content-encoding"] === "br" && zlib.brotliDecompressSync(r.body).equals(hitA.body), r.headers["content-encoding"]);
  }

  // ... and after a hit in B (B's worker 0 compresses)
  host = "shared2.example";
  await req(A, host, p);
  await settle();
  const hitB = await req(B, host, p);
  check("shared: fill in A, hit in B", cacheStatus(hitB) === "HIT", cacheStatus(hitB));
  check("shared: .br appears (made after a hit in B)", !!(await waitFor(() => entry(B, host, p).br, 15000)));
  await settle(300);
  for (const c of [A, B]) {
    const r = await req(c, host, p, { headers: { "Accept-Encoding": "br" } });
    check(`shared: ${c.name} serves the .br made after a hit in B`, r.headers["content-encoding"] === "br" && zlib.brotliDecompressSync(r.body).equals(hitB.body), r.headers["content-encoding"]);
  }

  console.log("fill in flight during a purge");
  host = "inflight.example";
  p = "/slow-stream";
  const slow = req(B, host, p);
  await sleep(1200);
  const during = purge(A, [host]);
  const r = await slow;
  check("purge during the fill answered 200", during.code === 200, during.code);
  check("the in-flight client still got the whole body", r.status === 200 && r.body.length === 2048000, `${r.status} ${r.body.length}`);
  await sleep(500);
  check("nothing was published for the key", !entry(A, host, p).meta && !entry(A, host, p).body, JSON.stringify(files(A, host)));
  const next = await req(A, host, p);
  check("next request is a MISS", cacheStatus(next) === "MISS", cacheStatus(next));
}

// One client reads a large body slowly; a second asks for the same key and
// must not queue behind it
function slowClient(c, host, p, bytesPerSecond) {
  let received = 0;
  let finished = false;
  let request;
  const done = new Promise((resolve) => {
    request = http.get({ host: "127.0.0.1", port: c.http, path: p, agent: false, headers: { Host: host } }, (res) => {
      res.on("data", (chunk) => {
        received += chunk.length;
        res.pause();
        setTimeout(() => res.resume(), (chunk.length / bytesPerSecond) * 1000);
      });
      res.on("end", () => {
        finished = true;
        resolve();
      });
      res.on("error", resolve);
    });
    request.on("error", resolve);
  });
  return { done, received: () => received, finished: () => finished, abort: () => request.destroy() };
}

async function slowClients() {
  console.log("slow client does not hold the fill lock");
  const size = 3 * 1024 * 1024;
  for (const [label, p, limitMs] of [["Content-Length", "/large", 2000], ["chunked, no Content-Length", "/large-chunked", 4500]]) {
    const host = "slow-" + (p === "/large" ? "cl" : "chunked") + ".example";
    // ~350 KB/s: 3 MB takes about 9 s
    const slow = slowClient(A, host, p, 350 * 1024);
    await sleep(600);
    const fast = await req(A, host, p);
    const stillSlow = !slow.finished();
    check(`${label}: second client gets the whole body`, fast.status === 200 && fast.body.length === size, `${fast.status} ${fast.body.length}`);
    check(`${label}: second client done in under ${limitMs} ms (took ${fast.ms})`, fast.ms < limitMs, fast.ms);
    check(`${label}: the slow client was still downloading then`, stillSlow, `received ${slow.received()}`);
    slow.abort();
    await slow.done;
    await settle();
  }
}

async function rateLimit() {
  console.log("rate limit on hits");
  const host = "rl.example";
  const offline = fs.readFileSync(path.join(__dirname, "..", "html", "error-upstream-offline-blog.html"));
  await req(RL, host, "/rl-page");
  await settle();
  const statuses = {};
  let limited;
  // 80 at once: general allows 6 a second plus a burst of 30 that is delayed
  // rather than refused, so about 31 are served (some after a delay) and the
  // rest get 429
  const rs = await Promise.all(Array.from({ length: 80 }, () => req(RL, host, "/rl-page").catch((e) => ({ status: "err:" + e.message, headers: {}, body: Buffer.alloc(0) }))));
  for (const r of rs) {
    statuses[r.status] = (statuses[r.status] || 0) + 1;
    if (r.status === 429 && !limited) limited = r;
  }
  check("hammering a cached URL past the burst gets 429", !!limited, JSON.stringify(statuses));
  if (limited) {
    check("429 body is the blog offline page, not nginx's bare 429", limited.body.equals(offline), limited.body.toString().slice(0, 80));
  }
}

// ---- evict.sh -----------------------------------------------------------

const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

// Build a scratch cache directory in container A and run the sweeper on it
const EVICT = "/usr/local/bin/diskcache-evict";

function evict(dir, maxBytes, fsMax = 100) {
  return sh(A, `${EVICT} ${dir} ${maxBytes} ${fsMax} 2>&1; echo "rc=$?"`);
}

const summary = (out) => (out.match(/^evict: .*$/m) || [""])[0];
const field = (out, name) => parseInt((summary(out).match(new RegExp(name + "=(\\d+)")) || [])[1], 10);

async function evictChecks() {
  console.log("evict.sh");
  const hourAndMore = stamp(Date.now() - 2 * 3600 * 1000);
  const fresh = stamp(Date.now() - 60 * 1000);

  // -- least recently read first, whole entries --
  const d1 = "/tmp/dc-evict-lru";
  const host = `${d1}/a/bc/lru.example`;
  const keys = ["k1", "k2", "k3", "k4", "k5"];
  // read order, oldest first: k3, k1, k5, k2, k4
  const atimes = { k3: "2020-01-01 00:00:00", k1: "2020-01-02 00:00:00", k5: "2020-01-03 00:00:00", k2: "2020-01-04 00:00:00", k4: "2020-01-05 00:00:00" };
  let script = `rm -rf ${d1}; mkdir -p ${host}/.tmp; cd ${host};`;
  for (const k of keys) {
    script += `echo '{}' > ${k}.meta; dd if=/dev/zero of=${k}.id1 bs=1024 count=100 2>/dev/null; dd if=/dev/zero of=${k}.id1.br bs=1024 count=20 2>/dev/null;`;
    script += `touch -a -d '${atimes[k]}' ${k}.meta;`;
  }
  sh(A, script);
  const first = evict(d1, 1e12);
  check("summary line is printed", /^evict: entries=5 bytes=\d+ deleted=0 evicted=0 freed=0 seconds=\d+$/m.test(first), first);
  check("nothing evicted under the budget", shTry(A, `ls ${host} | wc -l`).trim() === "15");
  const total = field(first, "bytes");
  const each = total / 5;
  // need = total - 0.9 * max; aim for 2.5 entries so exactly three go
  const max = Math.round((2.5 * each) / 0.9);
  const second = evict(d1, max);
  check("exit status 0", /rc=0$/.test(second.trim()), second);
  check("three entries evicted", field(second, "evicted") === 3, summary(second));
  const left = shTry(A, `ls ${host}`).split("\n").filter(Boolean);
  const survivors = [...new Set(left.map((f) => f.split(".")[0]))].sort();
  check("least recently read entries (by .meta atime) went first", survivors.join() === "k2,k4", survivors.join());
  check("survivors keep every file (meta, body, .br)", ["k2", "k4"].every((k) => left.includes(k + ".meta") && left.includes(k + ".id1") && left.includes(k + ".id1.br")), left.join(" "));
  check("evicted entries lost every file", !left.some((f) => /^k[135]\./.test(f)), left.join(" "));
  sh(A, `rm -rf ${d1}`);

  // -- housekeeping --
  const d2 = "/tmp/dc-evict-junk";
  const h2 = `${d2}/b/cd/junk.example`;
  sh(A, [
    `rm -rf ${d2}; mkdir -p ${h2}/.tmp ${d2}/.trash/old/sub; cd ${h2}`,
    // entry without .meta: old is removed, recent is kept
    `echo x > orphanold.id1; touch -d '${hourAndMore}' orphanold.id1`,
    `echo x > orphannew.id1; touch -d '${fresh}' orphannew.id1`,
    // .tmp files
    `echo x > .tmp/old; touch -d '${hourAndMore}' .tmp/old`,
    `echo x > .tmp/new; touch -d '${fresh}' .tmp/new`,
    // an entry whose body is gone: its old .br goes, a recent one stays
    `echo '{}' > good.meta; echo body > good.id1`,
    `echo br > good.id0.br; touch -d '${hourAndMore}' good.id0.br`,
    `echo br > good.id9.br; touch -d '${fresh}' good.id9.br`,
    `echo x > ${d2}/.trash/old/sub/file`,
  ].join("\n"));
  const j = evict(d2, 1e12);
  const remaining = shTry(A, `cd ${h2} && find . -type f | sort`).split("\n").filter(Boolean);
  check("entry without .meta older than an hour is deleted", !remaining.includes("./orphanold.id1"), remaining.join(" "));
  check("entry without .meta newer than an hour is kept", remaining.includes("./orphannew.id1"));
  check(".tmp file older than an hour deleted", !remaining.includes("./.tmp/old"));
  check(".tmp file newer than an hour kept", remaining.includes("./.tmp/new"));
  check("old .br without its body deleted", !remaining.includes("./good.id0.br"));
  check("recent .br without its body kept", remaining.includes("./good.id9.br"));
  check("entry with metadata untouched", remaining.includes("./good.meta") && remaining.includes("./good.id1"));
  check(".trash emptied", shTry(A, `ls -A ${d2}/.trash`).trim() === "");
  check("summary counts the deletions", field(j, "deleted") === 3, summary(j));
  sh(A, `rm -rf ${d2}`);

  // -- another sweep running --
  const d3 = "/tmp/dc-evict-lock";
  const locked = sh(A, `rm -rf ${d3}; mkdir -p ${d3}/a/bc/h; (flock ${d3}/.evict.lock sleep 4) & sleep 0.5; ${EVICT} ${d3} 1000000 100; echo "rc=$?"; wait`);
  check("a concurrent run says another sweep is running", /evict: another sweep is running/.test(locked), locked);
  check("... and exits 0", /rc=0/.test(locked), locked);
  sh(A, `rm -rf ${d3}`);

  // -- host directories renamed away while the walk runs (a purge) --
  const d4 = "/tmp/dc-evict-race";
  sh(A, `rm -rf ${d4}; mkdir -p ${d4}/.trash; for n in $(seq 1 40); do mkdir -p ${d4}/a/bc/h$n; (cd ${d4}/a/bc/h$n && seq 1 400 | sed 's/$/.meta/' | xargs touch); done`);
  const raced = sh(A, `(sleep 0.02; for n in $(seq 1 40); do mv ${d4}/a/bc/h$n ${d4}/.trash/h$n 2>/dev/null; done) & ${EVICT} ${d4} 1000 100 2>&1; echo "rc=$?"; wait`);
  check("a host directory renamed away mid-sweep does not make it fail", /rc=0$/.test(raced.trim()) && /^evict: /m.test(raced), raced.slice(-300));
  sh(A, `rm -rf ${d4}`);
}

// ---- logs ---------------------------------------------------------------

function logChecks() {
  console.log("container logs");
  // limit_req / limit_conn log at [error] by default, and clients that hang
  // up are expected from the slow-client checks
  const expected = [/limiting requests/, /limiting connections/, /client prematurely closed/, /upstream prematurely closed/, /recv\(\) failed/, /send\(\) failed/, /writev\(\) failed/, /upstream timed out/, /connect\(\) failed/, /no live upstreams/];
  for (const c of ALL) {
    const log = dockerTry("logs", c.name);
    const errors = log.split("\n").filter((l) => /\[(error|crit|alert|emerg)\]/.test(l));
    const unexpected = errors.filter((l) => !expected.some((re) => re.test(l)));
    const ours = unexpected.filter((l) => /diskcache|lua/i.test(l));
    check(`${c.name}: no [error]/[crit] from diskcache or Lua`, ours.length === 0, ours.slice(0, 3).join(" | "));
    if (unexpected.length > ours.length) {
      console.log(`  note - ${c.name}: other [error] lines: ${unexpected.length - ours.length}, e.g. ${unexpected.find((l) => !ours.includes(l)).slice(0, 200)}`);
    }
  }
}


// How the headers Node sends come back on a hit (proxy/e2e/parity-checks.js
// compares them with the previous proxy's)
async function nodeHeaders() {
  console.log("headers Node sends, on a miss and on a hit");
  const host = "nodehdr.example";
  const count = (r, name) => r.rawHeaders.filter((h, i) => i % 2 === 0 && h.toLowerCase() === name).length;

  // Set-Cookie: whoever fills the entry gets it, nobody after
  let m = await req(A, host, "/p/set-cookie");
  await settle();
  let h = await req(A, host, "/p/set-cookie");
  check("Set-Cookie: the miss passes both cookies to the client", count(m, "set-cookie") === 2, String(count(m, "set-cookie")));
  check("Set-Cookie: the next request is a HIT without a cookie", cacheStatus(h) === "HIT" && count(h, "set-cookie") === 0, `${cacheStatus(h)} ${count(h, "set-cookie")}`);

  // Cache-Control, Expires and Pragma from Node do not stop the entry being stored, and are sent on
  m = await req(A, host, "/p/cache-control");
  await settle();
  h = await req(A, host, "/p/cache-control");
  check("Cache-Control: no-store, Expires in the past: still stored (a HIT)", cacheStatus(h) === "HIT", cacheStatus(h));
  for (const name of ["cache-control", "expires", "pragma"]) {
    check(`${name} on the hit is what Node sent`, h.headers[name] === m.headers[name] && !!h.headers[name], `${m.headers[name]} / ${h.headers[name]}`);
  }

  // The same header twice stays twice
  m = await req(A, host, "/p/dup");
  await settle();
  h = await req(A, host, "/p/dup");
  check("two Link headers on the miss", count(m, "link") === 2, String(count(m, "link")));
  check("two Link headers on the hit", count(h, "link") === 2, String(count(h, "link")));
  check("two X-Dup headers on the hit", count(h, "x-dup") === 2, String(count(h, "x-dup")));

  // A hit whose body is gone once its .meta was read (a refill, an eviction or
  // a purge in between) falls through to a fill: Node's headers only, not the
  // stored ones as well. An entry never served as a hit, so no worker's
  // open_file_cache still holds the deleted body open (that would be a correct
  // HIT).
  await req(A, host, "/p/dup?gone");
  await waitFor(() => entry(A, host, "/p/dup?gone").meta);
  const gone = entry(A, host, "/p/dup?gone");
  sh(A, `rm -f ${CACHE}/${hostDir(host)}/${gone.body}`);
  const f = await req(A, host, "/p/dup?gone");
  check("body gone after its .meta: a MISS, the stored headers not sent as well", cacheStatus(f) === "MISS" && count(f, "link") === 2 && count(f, "x-dup") === 2 && count(f, "blot-cache") === 1, `${cacheStatus(f)} link=${count(f, "link")} x-dup=${count(f, "x-dup")} blot-cache=${count(f, "blot-cache")}`);

  // No Content-Type from Node: none on the hit (nginx would otherwise add its default)
  m = await req(A, host, "/p/no-content-type");
  await settle();
  h = await req(A, host, "/p/no-content-type");
  check("no Content-Type on the miss", m.headers["content-type"] === undefined, m.headers["content-type"]);
  check("no Content-Type on the hit either", cacheStatus(h) === "HIT" && h.headers["content-type"] === undefined, `${cacheStatus(h)} ${h.headers["content-type"]}`);

  // A long header value (6000 bytes) and Content-Disposition come back whole
  m = await req(A, host, "/p/long-header");
  await settle();
  h = await req(A, host, "/p/long-header");
  check("a 6000 byte header value survives a hit", h.headers["x-long"] === m.headers["x-long"] && m.headers["x-long"].length === 6000, String((h.headers["x-long"] || "").length));
  m = await req(A, host, "/p/content-disposition");
  await settle();
  h = await req(A, host, "/p/content-disposition");
  check("Content-Disposition survives a hit", h.headers["content-disposition"] === m.headers["content-disposition"] && !!m.headers["content-disposition"], h.headers["content-disposition"]);

  // Range on a hit: several ranges, and one that cannot be satisfied
  const p = "/p/strong-etag";
  m = await req(A, host, p);
  await settle();
  const multi = await req(A, host, p, { headers: { Range: "bytes=0-9,20-29" } });
  check("two ranges: 206 multipart/byteranges", multi.status === 206 && /^multipart\/byteranges; boundary=/.test(multi.headers["content-type"] || ""), `${multi.status} ${multi.headers["content-type"]}`);
  check("the parts are the right bytes", multi.body.includes(m.body.subarray(0, 10)) && multi.body.includes(m.body.subarray(20, 30)));
  const unsat = await req(A, host, p, { headers: { Range: "bytes=99999999-" } });
  check("unsatisfiable range: 416 with the length", unsat.status === 416 && unsat.headers["content-range"] === `bytes */${m.body.length}`, `${unsat.status} ${unsat.headers["content-range"]}`);

  // A query string makes another entry, however alike; a miss for one never answers for the other
  const q1 = await req(A, host, "/q?a=1&b=2");
  await settle();
  const q2 = await req(A, host, "/q?b=2&a=1");
  const q3 = await req(A, host, "/q?a=1&b=2");
  check("same query, other order: another entry (MISS)", cacheStatus(q2) === "MISS" && q2.body.toString() !== q1.body.toString(), cacheStatus(q2));
  check("the first query is a HIT with its own body", cacheStatus(q3) === "HIT" && q3.body.equals(q1.body));
}

// ---- main ---------------------------------------------------------------

async function main() {
  cleanup();
  try {
    await Promise.all(ALL.map(startProxy));
    const sections = [basicBlogAndSite, brotli, etag, redirectsAndErrors, nodeHeaders, purgeChecks, sharedCache, slowClients, rateLimit, evictChecks];
    for (const section of sections) {
      try {
        await section();
      } catch (e) {
        failures++;
        failed.push(section.name + " threw");
        console.log("  FAIL -", section.name, "threw", e && e.stack ? e.stack : e);
      }
    }
    logChecks();
  } finally {
    if (process.env.DC_KEEP !== "1") cleanup();
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`\n${passes} passed, ${failures} failed in ${seconds}s`);
  if (failures) console.log("failed:\n  " + failed.join("\n  "));
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  if (process.env.DC_KEEP !== "1") cleanup();
  process.exit(1);
});
