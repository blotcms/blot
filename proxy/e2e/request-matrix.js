// What a client sees through the proxy, request kind by request kind, against
// the REAL proxy image with the generated production config. Plain node, no
// dependencies. Run by the proxy-behaviour job in
// .github/workflows/integration.yml after the image is built:
//
//   docker build -f proxy/Dockerfile -t blot-proxy:e2e proxy/
//   node proxy/e2e/request-matrix.js
//
// The assertions describe the client's side only: status, headers, body, and
// whether Node was asked (the stub upstream, proxy/e2e/stub-upstream.js,
// counts the requests it gets). They never look at cache files or at how the
// cache is implemented, so one file can run against any implementation of the
// cached locations; a PR that changes one of these answers changes the line
// here, and the diff is the review. proxy/e2e/parity/AUDIT.md says which
// location serves each kind of request.
//
// "KNOWN:" in a check name marks behaviour that is asserted as it is today
// but looks wrong or risky; the reason is in the name. A PR that fixes one
// flips the assertion and drops the label.
//
// It starts its own containers (names prefixed rm-), each with the stub in
// its network namespace:
//
//   rm-a   the proxy most sections use (every address on the rate-limit whitelist)
//   rm-t   a proxy started with BLOT_PURGE_TOKEN=secret
//   rm-d   a proxy whose Node is stopped and started (section "node down")
//   rm-rl  a proxy whose rate limits are left on
//
// and removes them (and their volumes) at the end. Environment:
//
//   PROXY_IMAGE    image to test               (default blot-proxy:e2e)
//   RM_PORT_BASE   first of the host ports used (default 18120, uses 8)
//   RM_ONLY        regular expression: run only the sections whose name matches
//   RM_KEEP        1: leave the containers running afterwards
//
// Every section uses its own host names (and, on the site, its own path
// prefix), so one section's cache entries and rate-limit state cannot leak
// into another.

const http = require("http");
const http2 = require("http2");
const https = require("https");
const crypto = require("crypto");
const zlib = require("zlib");
const path = require("path");
const { execFileSync } = require("child_process");

const IMAGE = process.env.PROXY_IMAGE || "blot-proxy:e2e";
const BASE = parseInt(process.env.RM_PORT_BASE || "18120", 10);
const ONLY = process.env.RM_ONLY ? new RegExp(process.env.RM_ONLY) : null;
const STUB = path.join(__dirname, "stub-upstream.js");
const CACHE = "/var/cache/openresty";
const HTML_DIR = "/etc/openresty/html";

const A = { name: "rm-a", http: BASE, https: BASE + 1, volume: "rm-cache-a" };
const T = { name: "rm-t", http: BASE + 2, https: BASE + 3, volume: "rm-cache-t", env: ["BLOT_PURGE_TOKEN=secret"], token: "secret" };
const D = { name: "rm-d", http: BASE + 4, https: BASE + 5, volume: "rm-cache-d" };
const RL = { name: "rm-rl", http: BASE + 6, https: BASE + 7, volume: "rm-cache-rl", limited: true };
const ALL = [A, T, D, RL];

let passes = 0;
let failures = 0;
const failed = [];
const known = [];
const started = Date.now();

function check(name, cond, detail) {
  if (name.startsWith("KNOWN:")) known.push(name);
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
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 26 });
}

function dockerTry(...args) {
  try {
    return docker(...args);
  } catch (e) {
    return (e.stdout || "") + (e.stderr || "");
  }
}

const sh = (c, script) => docker("exec", c.name, "sh", "-c", script);

function cleanup() {
  for (const c of ALL) dockerTry("rm", "-f", c.name + "-stub", c.name);
  for (const c of ALL) dockerTry("volume", "rm", "-f", c.volume);
}

function stubUp(c) {
  try {
    sh(c, "wget -qO- -T1 http://127.0.0.1:8090/__counts >/dev/null 2>&1");
    return true;
  } catch (e) {
    return false;
  }
}

async function startProxy(c) {
  const args = ["run", "-d", "--name", c.name, "-p", `${c.http}:80`, "-p", `${c.https}:443`, "-e", "BLOT_HOST=localhost", "-v", `${c.volume}:${CACHE}`];
  for (const e of c.env || []) args.push("-e", e);
  docker(...args, IMAGE);

  // the stub shares the proxy's network namespace, as in the CI job
  startStub(c);
  if (!(await waitFor(() => stubUp(c), 40000, 500))) throw new Error(c.name + ": stub upstream did not come up");

  const proxyUp = await waitFor(async () => (await req(c, "ready.example", "/health").catch(() => ({}))).status === 200, 40000, 500);
  if (!proxyUp) throw new Error(c.name + ": proxy did not come up\n" + dockerTry("logs", c.name));

  if (!c.limited) {
    // every address on the geo whitelist (http.conf): no per-client rate or
    // connection limits (the same list the Bunny edges are on)
    dockerTry("exec", c.name, "sh", "-c", "printf '0.0.0.0/0 1;\\n::/0 1;\\n' > /etc/openresty/cdn-ips.conf && /usr/local/openresty/bin/openresty -s reload");
    await sleep(1500);
  }
  // a proxy that keeps an index of what it cached refuses purges until it is
  // built: wait for the first one to be accepted
  const ready = await waitFor(() => purge(c, ["ready.example"], c.token).code === 200, 60000, 500);
  if (!ready) throw new Error(c.name + ": purge never became ready");
}

function startStub(c) {
  docker("run", "-d", "--name", c.name + "-stub", "--network", "container:" + c.name, "-v", `${STUB}:/s.js:ro`, "node:22-alpine", "node", "/s.js");
}

// The stub restarts for the "node down" section: wait until it answers
async function stubRestart(c) {
  dockerTry("start", c.name + "-stub");
  if (!(await waitFor(() => stubUp(c), 30000, 300))) throw new Error(c.name + ": stub did not come back");
}

// Requests the stub in this container has seen for a path (query ignored).
// Retries while a restarted stub is starting.
function asked(c, p) {
  for (let i = 0; ; i++) {
    try {
      const all = JSON.parse(sh(c, "wget -qO- -T2 http://127.0.0.1:8088/__counts"));
      return all[p] || 0;
    } catch (e) {
      if (i === 20) throw e;
      execFileSync("sleep", ["0.5"]);
    }
  }
}

// ---- requests -----------------------------------------------------------

// One request. Resolves with { status, headers (lower case), rawHeaders, body
// (Buffer), ms, firstByteMs }. No redirects followed, no decompression: the
// bytes the proxy sent.
function req(c, host, p, { method = "GET", headers = {}, tls = false, h2 = false, body, timeout = 30000 } = {}) {
  if (h2) return req2(c, host, p, { method, headers, body });
  const t0 = Date.now();
  const mod = tls ? https : http;
  const options = {
    method,
    host: "127.0.0.1",
    port: tls ? c.https : c.http,
    path: p,
    agent: false,
    headers: { Host: host, "User-Agent": "Mozilla/5.0 (compatible; request-matrix)", ...headers },
    rejectUnauthorized: false,
    servername: tls ? host : undefined,
    timeout,
  };
  if (body !== undefined && options.headers["Content-Length"] === undefined) options.headers["Content-Length"] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    const r = mod.request(options, (res) => {
      const chunks = [];
      let firstByteMs = null;
      res.on("data", (d) => {
        if (firstByteMs === null) firstByteMs = Date.now() - t0;
        chunks.push(d);
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks), ms: Date.now() - t0, firstByteMs }));
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("aborted")));
    });
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", reject);
    r.end(body);
  });
}

function req2(c, host, p, { method, headers, body }) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const session = http2.connect(`https://127.0.0.1:${c.https}`, { rejectUnauthorized: false, servername: host });
    session.on("error", reject);
    const stream = session.request({
      ":method": method,
      ":path": p,
      ":authority": host,
      "user-agent": "Mozilla/5.0 (compatible; request-matrix)",
      ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
    });
    const chunks = [];
    let res = null;
    let firstByteMs = null;
    stream.on("response", (h) => (res = h));
    stream.on("data", (d) => {
      if (firstByteMs === null) firstByteMs = Date.now() - t0;
      chunks.push(d);
    });
    stream.on("end", () => {
      session.close();
      const out = {};
      for (const [k, v] of Object.entries(res)) if (k !== ":status") out[k] = v;
      resolve({ status: res[":status"], headers: out, rawHeaders: [], body: Buffer.concat(chunks), ms: Date.now() - t0, firstByteMs });
    });
    stream.on("error", (e) => {
      session.close();
      reject(e);
    });
    stream.setTimeout(30000, () => stream.close());
    stream.end(body);
  });
}

// A request that may end without an answer (a connection closed with 444)
const tryReq = (...args) => req(...args).catch((e) => ({ status: 0, headers: {}, rawHeaders: [], body: Buffer.alloc(0), error: e.message }));

const cache = (r) => r.headers["blot-cache"];
const text = (r) => r.body.toString();
// the stub's echo answers are JSON followed by padding
const echoOf = (r) => {
  const t = decode(r).toString();
  return JSON.parse(t.slice(0, t.lastIndexOf("}") + 1));
};
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const same = (a, b) => a.body.equals(b.body);
const rawValues = (r, name) => r.rawHeaders.reduce((out, v, i) => (i % 2 === 0 && v.toLowerCase() === name ? out.concat(r.rawHeaders[i + 1]) : out), []);

function decode(r) {
  const enc = (r.headers["content-encoding"] || "").toLowerCase();
  try {
    if (enc === "br") return zlib.brotliDecompressSync(r.body);
    if (enc === "gzip") return zlib.gunzipSync(r.body);
  } catch (e) {
    return Buffer.from("(undecodable " + enc + ")");
  }
  return r.body;
}

// A miss is recorded just after the response ends: give that a moment
// before the next request
const settle = (ms = 150) => sleep(ms);

// Request, wait for the record, return the response
async function get(c, host, p, o) {
  const r = await req(c, host, p, o);
  await settle();
  return r;
}

function purge(c, hosts, token) {
  const query = hosts.map((h) => "host=" + h).join("&");
  const header = token === undefined ? "" : `-H 'X-Blot-Purge-Token: ${token}'`;
  try {
    const out = sh(c, `curl -s -m 20 -w '\\n%{http_code}' ${header} 'http://127.0.0.1/purge?${query}'`);
    const lines = out.trimEnd().split("\n");
    return { code: parseInt(lines.pop(), 10), text: lines.join("\n") };
  } catch (e) {
    return { code: 0, text: String(e.message) };
  }
}

const offlineBlog = () => sh(A, `cat ${HTML_DIR}/error-upstream-offline-blog.html`);
const offlineSite = () => sh(A, `cat ${HTML_DIR}/error-upstream-offline-site.html`);

const SITE = "localhost";

// ---- sections -----------------------------------------------------------
//
// Each is an async function; the name is what RM_ONLY matches.

const sections = [];
const section = (name, fn) => sections.push({ name, fn });

// Every kind of document or file a blog serves through the cached location:
// the first request goes to Node, the second is answered without it
section("1 blog pages and files on a subdomain", async () => {
  const host = "s1.localhost";
  const kinds = [
    ["entry (html)", "/post/hello-world", /^text\/html/],
    ["page/2", "/page/2", /^text\/html/],
    ["tag page", "/tagged/news", /^text\/html/],
    ["archive", "/archive", /^text\/html/],
    ["feed.rss", "/feed.rss", /^application\/rss\+xml/],
    ["sitemap.xml", "/sitemap.xml", /^application\/xml/],
    ["robots.txt", "/robots.txt", /^text\/plain/],
    ["style.css", "/style.css", /^text\/css/],
    ["script.js", "/script.js", /^application\/javascript/],
    ["feed.json", "/feed.json", /^application\/json/],
    ["logo.svg", "/logo.svg", /^image\/svg\+xml/],
    ["photo.jpg", "/photo.jpg", /^image\/jpeg/],
    ["photo.png", "/photo.png", /^image\/png/],
    ["font.woff2", "/font.woff2", /^font\/woff2/],
    ["doc.pdf", "/doc.pdf", /^application\/pdf/],
    ["clip.mp4", "/clip.mp4", /^video\/mp4/],
    ["generated image", "/_image_cache/ab/photo.jpg", /^image\/jpeg/],
    ["generated asset", "/_assets/ab12cd/style.css", /^text\/css/],
    ["extension-less JSON (the stub's default answer)", "/anything", /^application\/json/],
  ];
  for (const [label, p, type] of kinds) {
    const before = asked(A, p);
    const first = await get(A, host, p);
    const second = await get(A, host, p);
    const n = asked(A, p) - before;
    check(
      `${label}: MISS then HIT, Node asked once, same body and type`,
      first.status === 200 && second.status === 200 && cache(first) === "MISS" && cache(second) === "HIT" && n === 1 && same(first, second) && type.test(first.headers["content-type"] || "") && type.test(second.headers["content-type"] || ""),
      `${first.status}/${second.status} ${cache(first)}/${cache(second)} asked ${n} type ${first.headers["content-type"]}`
    );
  }
  const r = await get(A, host, "/post/hello-world");
  check("a hit carries the proxy's own headers (Blot-Server, Server: openresty)", !!r.headers["blot-server"] && r.headers.server === "openresty", JSON.stringify(r.headers));
  const health = await req(A, host, "/health");
  check("KNOWN: no response from a blog host carries X-Content-Type-Options: nosniff, though http.conf sets it (the server block's add_header Alt-Svc replaces the inherited one)", r.headers["x-content-type-options"] === undefined && health.headers["x-content-type-options"] === undefined, `${r.headers["x-content-type-options"]} / ${health.headers["x-content-type-options"]}`);
  const up = await get(A, host, "/post/upstream-header");
  check("Blot-Upstream names the Node that answered, on a miss", /^127\.0\.0\.1:80(88|89|90|91)$/.test(up.headers["blot-upstream"] || ""), up.headers["blot-upstream"]);
});

section("2 hosts: subdomain, custom domain, site, preview, cdn", async () => {
  // a custom domain is any Host the blog server_name does not match: the default server
  const custom = "s2.example";
  let r1 = await get(A, custom, "/post/c");
  let r2 = await get(A, custom, "/post/c");
  check("custom domain (default server): MISS then HIT, Node asked once", cache(r1) === "MISS" && cache(r2) === "HIT" && asked(A, "/post/c") === 1, `${cache(r1)}/${cache(r2)}`);

  const www = await get(A, "www." + custom, "/post/c");
  check("www.<custom domain> is a separate entry", cache(www) === "MISS" && asked(A, "/post/c") === 2);

  // the site: https only (port 80 redirects), HTTP/1.1 and HTTP/2
  r1 = await get(A, SITE, "/s2/h1", { tls: true });
  r2 = await get(A, SITE, "/s2/h1", { tls: true });
  check("site over https (HTTP/1.1): MISS then HIT, Node asked once", r1.status === 200 && cache(r1) === "MISS" && cache(r2) === "HIT" && asked(A, "/s2/h1") === 1 && same(r1, r2), `${cache(r1)}/${cache(r2)}`);
  r1 = await get(A, SITE, "/s2/h2", { h2: true });
  r2 = await get(A, SITE, "/s2/h2", { h2: true });
  check("site over HTTP/2: MISS then HIT, Node asked once", r1.status === 200 && cache(r1) === "MISS" && cache(r2) === "HIT" && asked(A, "/s2/h2") === 1 && same(r1, r2), `${cache(r1)}/${cache(r2)}`);
  r1 = await get(A, SITE, "/s2/h1", { h2: true });
  check("the same site page over HTTP/2 after HTTP/1.1 is a HIT (one entry for both)", cache(r1) === "HIT" && asked(A, "/s2/h1") === 1);

  r1 = await req(A, SITE, "/s2/redirect");
  check("site on port 80 redirects to https and never asks Node", r1.status === 301 && r1.headers.location === "https://localhost/s2/redirect" && asked(A, "/s2/redirect") === 0, `${r1.status} ${r1.headers.location}`);

  // blogs over https: the key includes the scheme
  const host = "s2b.localhost";
  r1 = await get(A, host, "/post/scheme");
  r2 = await get(A, host, "/post/scheme", { tls: true });
  const r3 = await get(A, host, "/post/scheme", { tls: true });
  check("a blog over https is a separate entry from http (the scheme is in the key); then HIT", cache(r1) === "MISS" && cache(r2) === "MISS" && cache(r3) === "HIT" && asked(A, "/post/scheme") === 2, `${cache(r1)}/${cache(r2)}/${cache(r3)}`);

  // Host spellings
  r1 = await get(A, "S2c.localhost", "/post/spelling");
  r2 = await get(A, "s2c.localhost", "/post/spelling");
  check("Host is case-insensitive: one entry for S2c.localhost and s2c.localhost", cache(r1) === "MISS" && cache(r2) === "HIT" && asked(A, "/post/spelling") === 1, `${cache(r1)}/${cache(r2)}`);
  r1 = await get(A, "s2c.localhost:8080", "/post/spelling");
  check("a port in Host does not change the entry", cache(r1) === "HIT", String(cache(r1)));

  // preview and cdn are not cached
  const pv = "preview-s2.localhost";
  r1 = await req(A, pv, "/p/page");
  r2 = await req(A, pv, "/p/page");
  check("preview host: not cached, Node asked every time", r1.status === 200 && cache(r1) === undefined && cache(r2) === undefined && asked(A, "/p/page") === 2, `${cache(r1)}/${cache(r2)} asked ${asked(A, "/p/page")}`);
  r1 = await req(A, pv, "/p/page", { tls: true });
  check("preview host over https: served, not cached", r1.status === 200 && cache(r1) === undefined && asked(A, "/p/page") === 3);

  r1 = await req(A, "cdn.localhost", "/folder/v-1/blog_x/photo.jpg");
  r2 = await req(A, "cdn.localhost", "/folder/v-1/blog_x/photo.jpg");
  check("cdn host: files not on disk go to Node every time, not cached by the proxy", r1.status === 200 && cache(r1) === undefined && cache(r2) === undefined && asked(A, "/folder/v-1/blog_x/photo.jpg") === 2);
  r1 = await req(A, "cdn.localhost", "/p/ranged.bin", { headers: { Range: "bytes=0-99" } });
  check("cdn host passes Range to Node (Node answers 206)", r1.status === 206 && r1.body.length === 100, `${r1.status} ${r1.body.length}`);
  r1 = await req(A, "cdn.localhost", "/");
  check("cdn host root redirects to blot.im", r1.status === 301, String(r1.status));
});

section("3 query strings and URL forms are separate entries", async () => {
  const host = "s3.localhost";
  const cases = ["/post/q?a=1", "/post/q?a=2", "/post/q?a=1&b=2", "/post/q?b=2&a=1", "/post/q?", "/post/q", "/post/q?utm_source=x", "/post/q?a=%20b", "/post/q?a=+b"];
  const firsts = [];
  for (const p of cases) firsts.push(await get(A, host, p));
  check(`${cases.length} different query strings are ${cases.length} entries (every one a MISS, Node asked ${cases.length}x)`, firsts.every((r) => cache(r) === "MISS") && asked(A, "/post/q") === cases.length, firsts.map(cache).join(","));
  const seconds = [];
  for (const p of cases) seconds.push(await get(A, host, p));
  check("each is a HIT the second time, Node not asked again", seconds.every((r) => cache(r) === "HIT") && asked(A, "/post/q") === cases.length, seconds.map(cache).join(","));
  const long = await get(A, host, "/post/long?x=" + "y".repeat(3000));
  const long2 = await get(A, host, "/post/long?x=" + "y".repeat(3000));
  check("a 3000-byte query string is cached", long.status === 200 && cache(long) === "MISS" && cache(long2) === "HIT");
  const enc1 = await get(A, host, "/caf%C3%A9");
  const enc2 = await get(A, host, "/caf%c3%a9");
  check("percent-encoding case matters: %C3%A9 and %c3%a9 are different entries", cache(enc1) === "MISS" && cache(enc2) === "MISS");
  const trail = await get(A, host, "/post/trail/");
  const notrail = await get(A, host, "/post/trail");
  check("/x/ and /x are different entries", cache(trail) === "MISS" && cache(notrail) === "MISS");
  const dbl = await get(A, host, "/post//dbl");
  const dbl2 = await get(A, host, "/post//dbl");
  check("a path with // is passed to Node as sent and cached as its own entry", dbl.status === 200 && cache(dbl) === "MISS" && cache(dbl2) === "HIT");
});

section("4 statuses from Node", async () => {
  const host = "s4.localhost";
  for (const code of [200, 301, 302, 400, 404]) {
    const p = `/p/status/${code}`;
    const first = await get(A, host, p);
    const second = await get(A, host, p);
    const redirect = code === 301 || code === 302;
    check(
      `${code} is cached: MISS then HIT, Node asked once` + (redirect ? ", Location kept" : ""),
      first.status === code && second.status === code && cache(first) === "MISS" && cache(second) === "HIT" && asked(A, p) === 1 && same(first, second) && (!redirect || second.headers.location === "/p/target"),
      `${first.status}/${second.status} ${cache(first)}/${cache(second)} asked ${asked(A, p)}`
    );
  }
  for (const code of [307, 308, 401, 403, 410]) {
    const p = `/p/status/${code}`;
    const first = await get(A, host, p);
    const second = await get(A, host, p);
    check(
      `${code} passes through and is not cached: Node asked every time`,
      first.status === code && second.status === code && cache(first) !== "HIT" && cache(second) !== "HIT" && asked(A, p) === 2,
      `${first.status}/${second.status} ${cache(first)}/${cache(second)} asked ${asked(A, p)}`
    );
  }
  const blogOffline = offlineBlog();
  for (const code of [500, 502, 504, 429]) {
    const p = `/p/status/${code}`;
    const first = await get(A, host, p);
    const second = await get(A, host, p);
    check(
      `${code} from Node is replaced by the offline page (status ${code}) and not cached`,
      first.status === code && second.status === code && text(first) === blogOffline && text(second) === blogOffline && cache(second) !== "HIT" && asked(A, p) === 2,
      `${first.status}/${second.status} asked ${asked(A, p)} body ${text(first).slice(0, 40)}`
    );
  }
  const p503 = "/p/status/503";
  const a = await get(A, host, p503);
  const b = await get(A, host, p503);
  check(
    "503 from Node passes through with Retry-After and no-store (not the offline page), not cached",
    a.status === 503 && /^status 503/.test(text(a)) && a.headers["retry-after"] === "60" && a.headers["cache-control"] === "no-store" && b.status === 503 && cache(b) !== "HIT" && asked(A, p503) === 2,
    `${a.status} ${text(a).slice(0, 30)} asked ${asked(A, p503)}`
  );
  const u = await get(A, host, "/unavailable");
  check("the Redis-outage 503 (/unavailable) keeps Node's body and headers", u.status === 503 && text(u) === "temporarily unavailable" && u.headers["retry-after"] === "60");
  const boom = await get(A, host, "/boom");
  check("a plain Node 500 (/boom) gets the offline page too", boom.status === 500 && text(boom) === blogOffline);

  // the paths Blot really uses
  const r301 = await get(A, host, "/redirect-301");
  const r301b = await get(A, host, "/redirect-301");
  check("a redirect with no body and no Content-Type (/redirect-301) is cached with its Location", r301.status === 301 && r301b.status === 301 && cache(r301b) === "HIT" && r301b.headers.location === "/redirect-target" && r301b.body.length === 0 && asked(A, "/redirect-301") === 1);
  const nf = await get(A, host, "/notfound-page");
  const nf2 = await get(A, host, "/notfound-page");
  check("a Node 404 (/notfound-page) is cached", nf.status === 404 && nf2.status === 404 && cache(nf2) === "HIT" && text(nf2) === "not found" && asked(A, "/notfound-page") === 1);

  // custom domain and site behave alike
  const custom = "s4.example";
  const c404 = await get(A, custom, "/p/status/404");
  const c404b = await get(A, custom, "/p/status/404");
  const c500 = await get(A, custom, "/p/status/500");
  check("custom domain: 404 cached, 500 is the offline page", c404.status === 404 && cache(c404b) === "HIT" && c500.status === 500 && text(c500) === blogOffline);
  const s404s = await get(A, SITE, "/p/status/404", { tls: true });
  const s404t = await get(A, SITE, "/p/status/404", { tls: true });
  const s500 = await get(A, SITE, "/p/status/500", { tls: true });
  check("site: 404 cached, 500 is the site's offline page", s404s.status === 404 && cache(s404t) === "HIT" && s500.status === 500 && text(s500) === offlineSite());
  check("the site's offline page differs from the blogs'", offlineSite() !== blogOffline);
  const off = await req(A, host, "/error-upstream-offline.html");
  check("/error-upstream-offline.html is the offline page, served by the proxy (200, Node not asked)", off.status === 200 && text(off) === blogOffline && asked(A, "/error-upstream-offline.html") === 0, String(off.status));
});

// Node stopped: cached pages are still served, the rest get the offline page
section("5 node down", async () => {
  const blog = "s5.localhost";
  const custom = "s5.example";
  const warm = [
    [blog, "/post/cached", {}],
    [custom, "/post/cached", {}],
    [SITE, "/s5/cached", { tls: true }],
    [blog, "/style.css", {}],
  ];
  for (const [h, p, o] of warm) await get(D, h, p, o);
  await get(D, blog, "/p/status/404");
  await get(D, blog, "/redirect-301");
  const blogOffline = sh(D, `cat ${HTML_DIR}/error-upstream-offline-blog.html`);
  const siteOffline = sh(D, `cat ${HTML_DIR}/error-upstream-offline-site.html`);

  dockerTry("stop", "-t", "1", D.name + "-stub");
  await sleep(500);
  try {
    for (const [h, p, o] of warm) {
      const r = await req(D, h, p, o);
      check(`cached ${h}${p}: still served (HIT) with Node down`, r.status === 200 && cache(r) === "HIT", `${r.status} ${cache(r)}`);
    }
    const nf = await req(D, blog, "/p/status/404");
    const rd = await req(D, blog, "/redirect-301");
    check("a cached 404 and a cached redirect are served with Node down", nf.status === 404 && cache(nf) === "HIT" && rd.status === 301 && cache(rd) === "HIT");
    const head = await req(D, blog, "/post/cached", { method: "HEAD" });
    check("HEAD of a cached page is served with Node down", head.status === 200 && cache(head) === "HIT");

    const un = await req(D, blog, "/post/uncached");
    check("uncached blog page: the offline page, status 502, not cached", un.status === 502 && text(un) === blogOffline && cache(un) !== "HIT", `${un.status} ${text(un).slice(0, 40)}`);
    const unc = await req(D, custom, "/post/uncached");
    check("uncached custom-domain page: the offline page, 502", unc.status === 502 && text(unc) === blogOffline);
    const uns = await req(D, SITE, "/s5/uncached", { tls: true });
    check("uncached site page: the site's offline page, 502", uns.status === 502 && text(uns) === siteOffline, `${uns.status}`);
    const unq = await req(D, blog, "/post/cached?q=1");
    check("a query string makes it a different page: offline page, 502", unq.status === 502 && text(unq) === blogOffline);
    const unh = await req(D, blog, "/post/uncached", { method: "HEAD" });
    check("HEAD of an uncached page: 502", unh.status === 502, String(unh.status));
    const dyn = await req(D, SITE, "/dashboard", { tls: true });
    check("an uncached location (dashboard) with Node down: the site's offline page, 502", dyn.status === 502 && text(dyn) === siteOffline, `${dyn.status}`);
    const sse = await req(D, blog, "/draft/stream/x");
    check("an SSE location with Node down: 502", sse.status === 502, String(sse.status));
    const post = await req(D, SITE, "/clients/dropbox/webhook", { method: "POST", body: "x", tls: true });
    check("a webhook POST with Node down: 502", post.status === 502, String(post.status));
  } finally {
    await stubRestart(D);
  }
  await sleep(500);
  const back = await req(D, blog, "/post/uncached");
  const back2 = await get(D, blog, "/post/uncached");
  check("Node back: the page that got the offline page is served and cached (the offline answer was not stored)", back.status === 200 && /post\/uncached/.test(text(back)) && cache(back2) === "HIT", `${back.status} ${cache(back)}/${cache(back2)}`);
});

section("6 HEAD", async () => {
  const host = "s6.localhost";
  const p = "/post/head";
  const h1 = await get(A, host, p, { method: "HEAD" });
  check("HEAD on a miss: 200, no body, Content-Length of the page", h1.status === 200 && h1.body.length === 0 && cache(h1) === "MISS" && /^text\/html/.test(h1.headers["content-type"]) && parseInt(h1.headers["content-length"] || "0", 10) > 0, `${h1.status} ${cache(h1)} cl=${h1.headers["content-length"]}`);
  const before = asked(A, p);
  const g1 = await get(A, host, p);
  // disk cache: a HEAD is passed to Node as a HEAD and fills nothing (parity rule head-does-not-fill)
  check("HEAD on a miss fills nothing: the following GET is a MISS with the whole body, Node asked again", g1.status === 200 && cache(g1) === "MISS" && g1.body.length === parseInt(h1.headers["content-length"], 10) && asked(A, p) === before + 1, `${cache(g1)} len ${g1.body.length} cl ${h1.headers["content-length"]}`);
  const h2 = await get(A, host, p, { method: "HEAD" });
  check("HEAD on a hit: HIT, no body, same Content-Length and Content-Type", h2.status === 200 && cache(h2) === "HIT" && h2.body.length === 0 && h2.headers["content-length"] === String(g1.body.length) && h2.headers["content-type"] === g1.headers["content-type"]);
  const n404 = asked(A, "/p/status/404");
  const nf1 = await get(A, host, "/p/status/404", { method: "HEAD" });
  const nf2 = await get(A, host, "/p/status/404");
  // disk cache: parity rule head-does-not-fill
  check("HEAD of a 404 is not cached: the GET after it is a MISS", nf1.status === 404 && nf2.status === 404 && cache(nf2) === "MISS" && asked(A, "/p/status/404") - n404 === 2, `${nf1.status}/${nf2.status} ${cache(nf2)} asked ${asked(A, "/p/status/404") - n404}`);
  const rd = await get(A, host, "/p/status/301", { method: "HEAD" });
  check("HEAD of a redirect: 301 with Location", rd.status === 301 && rd.headers.location === "/p/target");
  const hs = await get(A, host, "/p/status/500", { method: "HEAD" });
  check("HEAD of a 500: the offline page's status, no body", hs.status === 500 && hs.body.length === 0);
  const hb = await get(A, host, "/photo.jpg", { method: "HEAD", headers: { "Accept-Encoding": "gzip, br" } });
  check("HEAD of a binary file: Content-Length, no Content-Encoding", hb.status === 200 && hb.headers["content-length"] === "20000" && !hb.headers["content-encoding"]);
  const hc = await get(A, host, "/style.css", { method: "HEAD", headers: { "Accept-Encoding": "br" } });
  check("HEAD with Accept-Encoding: br of a compressible file says Content-Encoding: br", hc.status === 200 && hc.headers["content-encoding"] === "br" && hc.body.length === 0, `${hc.headers["content-encoding"]}`);
  const hp = await get(A, SITE, "/s6/head", { method: "HEAD", tls: true });
  const hg = await get(A, SITE, "/s6/head", { tls: true });
  // disk cache: parity rule head-does-not-fill
  check("site: HEAD fills nothing, the GET after is a MISS", hp.status === 200 && cache(hg) === "MISS", String(cache(hg)));
});

section("7 conditional GETs", async () => {
  const host = "s7.localhost";
  // /etag-page: Node sends ETag "node-etag-1"; the proxy does not forward conditional headers
  const m1 = await get(A, host, "/etag-page", { headers: { "If-None-Match": '"node-etag-1"' } });
  check("If-None-Match on a miss: 304 (compared with Node's fresh answer), no body", m1.status === 304 && m1.body.length === 0 && m1.headers.etag === '"node-etag-1"', `${m1.status} ${m1.headers.etag}`);
  const h1 = await get(A, host, "/etag-page", { headers: { "If-None-Match": '"node-etag-1"' } });
  check("If-None-Match on a hit: 304", h1.status === 304 && h1.body.length === 0);
  const h2 = await get(A, host, "/etag-page", { headers: { "If-None-Match": '"other"' } });
  check("If-None-Match that does not match: 200 with the whole page and ETag", h2.status === 200 && h2.body.length > 500 && h2.headers.etag === '"node-etag-1"' && cache(h2) === "HIT");
  const h3 = await get(A, host, "/etag-page", { headers: { "If-None-Match": '"other", "node-etag-1"' } });
  check("If-None-Match with a list containing the ETag: 304", h3.status === 304);
  const h4 = await get(A, host, "/etag-page", { headers: { "If-None-Match": "*" } });
  check("If-None-Match: * : 304", h4.status === 304);
  const h5 = await get(A, host, "/etag-page", { headers: { "If-None-Match": 'W/"node-etag-1"' } });
  check("If-None-Match with the weak form of the ETag: 304 (weak comparison)", h5.status === 304, String(h5.status));
  check("Node was asked once for /etag-page, however many conditionals", asked(A, "/etag-page") === 1);

  // /p/last-modified: Last-Modified Wed, 01 Jan 2020, ETag "lm-1"
  const lm = "/p/last-modified";
  await get(A, host, lm);
  const a = await get(A, host, lm, { headers: { "If-Modified-Since": "Wed, 01 Jan 2020 00:00:00 GMT" } });
  check("If-Modified-Since equal to Last-Modified: 304", a.status === 304 && a.body.length === 0);
  const b = await get(A, host, lm, { headers: { "If-Modified-Since": "Wed, 01 Jan 2025 00:00:00 GMT" } });
  check("If-Modified-Since later than Last-Modified: 200 (the date must match exactly, if_modified_since exact)", b.status === 200, String(b.status));
  const c = await get(A, host, lm, { headers: { "If-Modified-Since": "Tue, 01 Jan 2019 00:00:00 GMT" } });
  check("If-Modified-Since earlier than Last-Modified: 200, whole page", c.status === 200 && c.body.length > 500 && c.headers["last-modified"] === "Wed, 01 Jan 2020 00:00:00 GMT");
  const d = await get(A, host, lm, { headers: { "If-None-Match": '"nope"', "If-Modified-Since": "Wed, 01 Jan 2025 00:00:00 GMT" } });
  check("both validators, the ETag not matching: the If-None-Match decides, 200", d.status === 200, String(d.status));
  const e = await get(A, host, lm, { headers: { "If-Modified-Since": "garbage" } });
  check("an unparseable If-Modified-Since is ignored: 200", e.status === 200 && e.body.length > 500);
  const f = await get(A, host, lm, { headers: { "If-Match": '"nope"' } });
  check("If-Match that does not match: 412", f.status === 412, String(f.status));
  const w = await get(A, host, "/p/weak-etag", { headers: { "If-None-Match": 'W/"weak-1"' } });
  const w2 = await get(A, host, "/p/weak-etag", { headers: { "If-None-Match": 'W/"weak-1"' } });
  check("a weak ETag from Node is kept and matched by If-None-Match: 304 on a miss and on a hit", w.status === 304 && w2.status === 304 && w2.headers.etag === 'W/"weak-1"', `${w.status}/${w2.status} ${w2.headers.etag}`);

  // a page with no validators
  const cond = { "If-None-Match": '"x"', "If-Modified-Since": "Wed, 01 Jan 2025 00:00:00 GMT" };
  const nv = await get(A, host, "/post/novalidator", { headers: cond });
  const nv2 = await get(A, host, "/post/novalidator", { headers: cond });
  check("conditional GET of a page with no ETag or Last-Modified: 200 whole page, miss and hit", nv.status === 200 && nv2.status === 200 && cache(nv2) === "HIT" && nv2.body.length > 500);
  const n = await get(A, host, "/p/status/404", { headers: { "If-None-Match": '"x"' } });
  check("conditional GET of a 404 is a 404", n.status === 404);

  // conditional headers reach Node only on uncached locations
  const pv = await req(A, "preview-s7.localhost", "/p/echo", { headers: { "If-None-Match": '"abc"', "If-Modified-Since": "Wed, 01 Jan 2020 00:00:00 GMT" } });
  const echo = echoOf(pv);
  check("preview host forwards If-None-Match and If-Modified-Since to Node", echo.headers["if-none-match"] === '"abc"' && !!echo.headers["if-modified-since"], JSON.stringify(echo.headers));
  const cp = await req(A, host, "/p/echo?cond=1", { headers: { "If-None-Match": '"abc"', "If-Modified-Since": "Wed, 01 Jan 2020 00:00:00 GMT" } });
  const echo2 = echoOf(cp);
  check("the cached location does not forward conditional headers to Node", !echo2.headers["if-none-match"] && !echo2.headers["if-modified-since"], JSON.stringify(echo2.headers));
});

section("8 Range", async () => {
  const host = "s8.localhost";
  // pages without Accept-Ranges
  const page = "/post/range";
  const f1 = await get(A, host, page, { headers: { Range: "bytes=0-99" } });
  check("KNOWN: a first Range request on a page Node sends without Accept-Ranges gets the whole body (200), not a 206", f1.status === 200 && f1.body.length > 500 && !f1.headers["content-range"], `${f1.status} ${f1.body.length} ${f1.headers["content-range"]}`);
  const h1 = await get(A, host, page, { headers: { Range: "bytes=0-99" } });
  // disk cache: the static module serves a hit and honours Range (parity rule range-on-hit)
  check("Range on a hit of a page without Accept-Ranges: 206 with those bytes", h1.status === 206 && h1.body.length === 100 && h1.headers["content-range"] === `bytes 0-99/${f1.body.length}`, `${h1.status} ${h1.body.length} ${h1.headers["content-range"]}`);
  check("those Range requests asked Node once for the page", asked(A, page) === 1, String(asked(A, page)));

  // a file Node answers with Accept-Ranges (folder files)
  const bin = "/p/ranged.bin";
  const all = await get(A, "s8a.localhost", bin);
  const first = await get(A, "s8b.localhost", bin, { headers: { Range: "bytes=0-99" } });
  check("first Range request, Node sends Accept-Ranges: 206 with Content-Range (the proxy fetches the whole file from Node and ranges it)", first.status === 206 && first.body.length === 100 && first.headers["content-range"] === "bytes 0-99/10000", `${first.status} ${first.body.length} ${first.headers["content-range"]}`);
  const askedBefore = asked(A, bin);
  const firstFull = await get(A, "s8b.localhost", bin);
  check("and that request filled the entry: the next full request is a HIT with the whole file", firstFull.status === 200 && cache(firstFull) === "HIT" && firstFull.body.length === 10000 && asked(A, bin) === askedBefore, `${firstFull.status} ${cache(firstFull)} ${firstFull.body.length} asked ${asked(A, bin)}`);
  const firstSuffix = await get(A, "s8c.localhost", bin, { headers: { Range: "bytes=-50" } });
  check("first request, suffix range bytes=-50: 206 with the last 50 bytes", firstSuffix.status === 206 && firstSuffix.body.length === 50 && firstSuffix.body.equals(all.body.subarray(9950)), `${firstSuffix.status} ${firstSuffix.body.length}`);
  const firstBad = await get(A, "s8d.localhost", bin, { headers: { Range: "bytes=99999999-" } });
  check("first request, range past the end: 416", firstBad.status === 416, `${firstBad.status} ${firstBad.headers["content-range"]}`);
  const firstBad2 = await get(A, "s8d.localhost", bin);
  // disk cache: the fill stores the whole file behind the 416 (parity rule unsatisfiable-range-stored)
  check("the 416 stored the file: the full request after it is a HIT with the whole file", cache(firstBad2) === "HIT" && firstBad2.body.length === 10000, `${cache(firstBad2)} ${firstBad2.body.length}`);

  // on a hit
  const hit = await get(A, "s8a.localhost", bin);
  check("the file is a HIT with Accept-Ranges, ETag and Last-Modified", cache(hit) === "HIT" && hit.headers["accept-ranges"] === "bytes" && hit.headers.etag === '"ranged-1"' && !!hit.headers["last-modified"]);
  const r1 = await get(A, "s8a.localhost", bin, { headers: { Range: "bytes=10-19" } });
  check("Range on a hit: 206, Content-Range, only those bytes", r1.status === 206 && r1.headers["content-range"] === "bytes 10-19/10000" && r1.body.equals(all.body.subarray(10, 20)), `${r1.status} ${r1.headers["content-range"]}`);
  const r2 = await get(A, "s8a.localhost", bin, { headers: { Range: "bytes=-50" } });
  check("suffix range on a hit: the last 50 bytes", r2.status === 206 && r2.headers["content-range"] === "bytes 9950-9999/10000" && r2.body.equals(all.body.subarray(9950)));
  const r3 = await get(A, "s8a.localhost", bin, { headers: { Range: "bytes=9990-" } });
  check("open-ended range on a hit", r3.status === 206 && r3.body.length === 10 && r3.headers["content-range"] === "bytes 9990-9999/10000");
  const r4 = await get(A, "s8a.localhost", bin, { headers: { Range: "bytes=0-4,10-14" } });
  check("multi-range on a hit: multipart/byteranges with both parts", r4.status === 206 && /^multipart\/byteranges; boundary=/.test(r4.headers["content-type"]) && r4.body.includes("Content-Range: bytes 0-4/10000") && r4.body.includes("Content-Range: bytes 10-14/10000"), `${r4.status} ${r4.headers["content-type"]}`);
  const r5 = await get(A, "s8a.localhost", bin, { headers: { Range: "bytes=20000-30000" } });
  check("unsatisfiable range on a hit: 416 with Content-Range: bytes */10000", r5.status === 416 && r5.headers["content-range"] === "bytes */10000", `${r5.status} ${r5.headers["content-range"]}`);
  const r6 = await get(A, "s8a.localhost", bin, { headers: { Range: "bytes=5-2" } });
  check("an invalid range (5-2) on a hit: 416", r6.status === 416, `${r6.status}`);
  const r7 = await get(A, "s8a.localhost", bin, { headers: { Range: "items=0-5" } });
  check("a range in another unit: the whole file", r7.status === 200 && r7.body.length === 10000);
  const r8 = await get(A, "s8a.localhost", bin, { headers: { Range: "bytes=0-99", "If-Range": '"ranged-1"' } });
  check("If-Range matching the ETag: 206", r8.status === 206 && r8.body.length === 100, String(r8.status));
  const r9 = await get(A, "s8a.localhost", bin, { headers: { Range: "bytes=0-99", "If-Range": '"stale"' } });
  check("If-Range not matching the ETag: the whole file (200)", r9.status === 200 && r9.body.length === 10000, String(r9.status));
  const r10 = await get(A, "s8a.localhost", bin, { headers: { Range: "bytes=0-99", "If-Range": "Wed, 01 Jan 2020 00:00:00 GMT" } });
  check("If-Range with the Last-Modified date: 206", r10.status === 206, String(r10.status));
  const r11 = await get(A, "s8a.localhost", bin, { headers: { Range: "bytes=0-99", "If-Range": "Tue, 01 Jan 2019 00:00:00 GMT" } });
  check("If-Range with another date: the whole file (200)", r11.status === 200 && r11.body.length === 10000, String(r11.status));
  const r12 = await get(A, "s8a.localhost", bin, { headers: { Range: "bytes=0-99" }, method: "HEAD" });
  check("HEAD with Range on a hit: 206 headers, no body", r12.status === 206 && r12.body.length === 0, String(r12.status));
  const r13 = await get(A, "s8a.localhost", bin, { headers: { Range: "bytes=0-99", "Accept-Encoding": "gzip" } });
  check("Range on a hit with Accept-Encoding: gzip of a binary: plain bytes 0-99", r13.status === 206 && r13.body.equals(all.body.subarray(0, 100)));

  // a compressible entry and a large one that Node sent without Accept-Ranges
  const css = "/style.css";
  await get(A, host, css);
  const c1 = await get(A, host, css, { headers: { Range: "bytes=0-9", "Accept-Encoding": "gzip" } });
  check("Range on a hit of a CSS file without Accept-Ranges from Node: the whole body, 200", c1.status === 200 && decode(c1).length > 500, `${c1.status} ${c1.headers["content-encoding"]}`);
  await get(A, host, "/large");
  const b1 = await get(A, host, "/large", { headers: { Range: "bytes=1048576-1048675" } });
  // disk cache: parity rule range-on-hit
  check("a range into a 3 MB entry that Node sent without Accept-Ranges: 206 with those bytes", b1.status === 206 && b1.body.length === 100 && b1.headers["content-range"] === `bytes 1048576-1048675/${3 * 1024 * 1024}`, `${b1.status} ${b1.body.length} ${b1.headers["content-range"]}`);
});

section("9 Accept-Encoding", async () => {
  const host = "s9.localhost";
  const css = "/style.css";
  const askedBefore = asked(A, css);
  const plain = await get(A, host, css, { headers: { "Accept-Encoding": "identity" } });
  const variants = [
    ["br", "br", "br"],
    ["gzip", "gzip", "gzip"],
    ["gzip, deflate, br", "gzip, deflate, br", "br"],
    ["br, gzip", "br, gzip", "br"],
    ["gzip, br", "gzip, br", "br"],
    ["identity", "identity", undefined],
    ["none", undefined, undefined],
    ["gzip;q=0", "gzip;q=0", undefined],
    ["br;q=0, gzip", "br;q=0, gzip", "gzip"],
    ["gzip;q=0.5, br;q=0.1", "gzip;q=0.5, br;q=0.1", "br"],
    ["*", "*", undefined],
    ["deflate", "deflate", undefined],
    ["zstd", "zstd", undefined],
  ];
  check("plain CSS: 200, no Content-Encoding, Vary: Accept-Encoding", plain.status === 200 && !plain.headers["content-encoding"] && /Accept-Encoding/i.test(plain.headers.vary || ""), `${plain.status} ${plain.headers.vary}`);
  for (const [label, ae, expected] of variants) {
    const r = await get(A, host, css, ae === undefined ? {} : { headers: { "Accept-Encoding": ae } });
    check(
      `Accept-Encoding ${label}: ${expected || "plain"}, decoded body equals the plain body, Vary: Accept-Encoding`,
      r.status === 200 && r.headers["content-encoding"] === expected && decode(r).equals(plain.body) && /Accept-Encoding/i.test(r.headers.vary || ""),
      `${r.status} enc=${r.headers["content-encoding"]} vary=${r.headers.vary} same=${decode(r).equals(plain.body)}`
    );
  }
  check("one request to Node for all the encodings", asked(A, css) - askedBefore === 1, String(asked(A, css) - askedBefore));
  const br = await get(A, host, css, { headers: { "Accept-Encoding": "br" } });
  check("a compressed body is smaller than the plain one", br.body.length < plain.body.length / 2, `${br.body.length} vs ${plain.body.length}`);

  for (const [label, p] of [["HTML page", "/post/ae"], ["JSON (feed.json)", "/feed.json"], ["JavaScript", "/script.js"], ["SVG", "/logo.svg"], ["RSS", "/feed.rss"], ["plain text", "/robots.txt"], ["XML", "/sitemap.xml"]]) {
    const pl = await get(A, host, p);
    const z = await get(A, host, p, { headers: { "Accept-Encoding": "gzip" } });
    const b = await get(A, host, p, { headers: { "Accept-Encoding": "br" } });
    check(`${label}: gzip and br variants decode to the plain body`, z.headers["content-encoding"] === "gzip" && b.headers["content-encoding"] === "br" && decode(z).equals(pl.body) && decode(b).equals(pl.body), `${z.headers["content-encoding"]}/${b.headers["content-encoding"]}`);
  }
  for (const [label, p] of [["JPEG", "/photo.jpg"], ["PNG", "/photo.png"], ["WOFF2", "/font.woff2"], ["PDF", "/doc.pdf"], ["MP4", "/clip.mp4"]]) {
    const z = await get(A, host, p, { headers: { "Accept-Encoding": "gzip, br" } });
    check(`${label} is never compressed`, z.status === 200 && !z.headers["content-encoding"], `${z.headers["content-encoding"]}`);
  }
  const tiny = await get(A, host, "/tiny", { headers: { "Accept-Encoding": "gzip, br" } });
  check("a body under 256 bytes is not compressed", tiny.status === 200 && !tiny.headers["content-encoding"] && tiny.body.length < 256, `${tiny.status} ${tiny.headers["content-encoding"]} ${tiny.body.length}`);
  const nf = await get(A, host, "/p/status/404", { headers: { "Accept-Encoding": "br" } });
  const nf2 = await get(A, host, "/p/status/404", { headers: { "Accept-Encoding": "br" } });
  check("a cached 404 is compressed for br clients and decodes to the same body", nf2.status === 404 && nf2.headers["content-encoding"] === "br" && decode(nf2).equals(decode(nf)) && /^status 404/.test(decode(nf2).toString()));
  const red = await get(A, host, "/redirect-301", { headers: { "Accept-Encoding": "br" } });
  check("a redirect without a body is not compressed", red.status === 301 && !red.headers["content-encoding"]);

  const h1 = await get(A, host, css, { headers: { "Accept-Encoding": "br" } });
  await sleep(1500);
  const h2 = await get(A, host, css, { headers: { "Accept-Encoding": "br" } });
  check("repeated br requests of a hit (before and after a pause) decode to the same body", decode(h1).equals(plain.body) && decode(h2).equals(plain.body) && cache(h2) === "HIT");

  // site over https and h2
  const s = await get(A, SITE, "/s9/style.css", { tls: true, headers: { "Accept-Encoding": "br" } });
  const s2 = await get(A, SITE, "/s9/style.css", { h2: true, headers: { "Accept-Encoding": "gzip" } });
  check("site: br over HTTP/1.1 and gzip over HTTP/2 decode to the same CSS", s.headers["content-encoding"] === "br" && s2.headers["content-encoding"] === "gzip" && decode(s).equals(decode(s2)), `${s.headers["content-encoding"]}/${s2.headers["content-encoding"]}`);
  const sized = await get(A, host, css, { headers: { "Accept-Encoding": "gzip" } });
  check("a compressed answer's Content-Length, when there is one, is the compressed length", sized.headers["content-length"] === undefined || sized.headers["content-length"] === String(sized.body.length));
});

section("10 Vary and the headers Node sends", async () => {
  const host = "s10.localhost";
  const v1 = await get(A, host, "/p/vary", { headers: { Cookie: "a=1", "Accept-Language": "en" } });
  const v2 = await get(A, host, "/p/vary", { headers: { Cookie: "a=2", "Accept-Language": "fr" } });
  check("Vary: Cookie, Accept-Language from Node is ignored: another cookie and language get the HIT, Node asked once", cache(v1) === "MISS" && cache(v2) === "HIT" && asked(A, "/p/vary") === 1 && same(v1, v2), `${cache(v1)}/${cache(v2)}`);
  // disk cache: a hit drops Node's Vary, since one copy is served to everyone (parity rule vary-dropped-on-hit)
  check("Node's Vary is passed on to the client on the miss (with Accept-Encoding added); the hit says Vary: Accept-Encoding only", v1.headers.vary === "Accept-Encoding, Cookie, Accept-Language" && v2.headers.vary === "Accept-Encoding", `${v1.headers.vary} / ${v2.headers.vary}`);

  // Cache-Control / Expires from Node
  const cc = await get(A, host, "/p/cache-control");
  const cc2 = await get(A, host, "/p/cache-control");
  check("Cache-Control: private, no-store; Expires in the past; Pragma: no-cache do not stop the entry being cached (HIT, Node asked once)", cache(cc) === "MISS" && cache(cc2) === "HIT" && asked(A, "/p/cache-control") === 1);
  check("those headers are sent to the client as Node sent them, on miss and hit", cc.headers["cache-control"] === "private, no-store, max-age=0" && cc2.headers["cache-control"] === "private, no-store, max-age=0" && cc2.headers.pragma === "no-cache" && cc2.headers.expires === "Thu, 01 Jan 1970 00:00:00 GMT", JSON.stringify(cc2.headers));
  await get(A, host, "/p/cache-control-long");
  const long2 = await get(A, host, "/p/cache-control-long");
  check("a long Cache-Control and Expires from Node are passed on unchanged", long2.headers["cache-control"] === "public, max-age=31536000, immutable" && long2.headers.expires === "Fri, 01 Jan 2100 00:00:00 GMT" && cache(long2) === "HIT");
  const none = await get(A, host, "/post/no-cache-control");
  const none2 = await get(A, host, "/post/no-cache-control");
  check("when Node sends no Cache-Control the proxy adds none (miss and hit)", none.headers["cache-control"] === undefined && none2.headers["cache-control"] === undefined && none2.headers.expires === undefined);

  // pages Blot marks no-cache or private
  for (const [label, p, h, o] of [
    ["/draft/view/<file> (Cache-Control: no-cache)", "/draft/view/draft.txt", host, {}],
    ["/verify/domain-setup (Cache-Control: no-cache)", "/verify/domain-setup", host, {}],
    ["/verify/subscription-duration (Cache-Control: no-cache)", "/verify/subscription-duration", host, {}],
    ["site /questions/search (Cache-Control: private)", "/questions/search?query=abc", SITE, { tls: true }],
  ]) {
    const a = await get(A, h, p, o);
    const b = await get(A, h, p, o);
    const n = asked(A, p.split("?")[0]);
    check(`KNOWN: ${label} is stored and replayed to everyone, Node's Cache-Control ignored (a dashboard check or draft preview can be stale until the host is purged)`, a.status === 200 && cache(b) === "HIT" && n === 1, `${cache(a)}/${cache(b)} asked ${n}`);
  }
  const s1 = await get(A, host, "/search?q=alpha");
  const s2 = await get(A, host, "/search?q=beta");
  const s3 = await get(A, host, "/search?q=alpha");
  check("KNOWN: /search stores one entry per query string, so the cache grows with whatever visitors type", cache(s1) === "MISS" && cache(s2) === "MISS" && cache(s3) === "HIT" && asked(A, "/search") === 2);

  // Set-Cookie
  const sc1 = await get(A, host, "/p/set-cookie");
  const sc2 = await get(A, host, "/p/set-cookie", { headers: { Cookie: "other=1" } });
  // disk cache: no longer KNOWN, a hit does not replay the filler's cookies (parity rule set-cookie-not-replayed)
  check("Set-Cookie from Node reaches the visitor of the miss and is not replayed on a hit", rawValues(sc1, "set-cookie").length === 2 && cache(sc2) === "HIT" && rawValues(sc2, "set-cookie").length === 0, `${rawValues(sc1, "set-cookie")} // ${rawValues(sc2, "set-cookie")}`);
  const q1 = await get(A, SITE, "/questions/replies", { tls: true });
  const q2 = await get(A, SITE, "/questions/replies", { tls: true });
  const q3 = await get(A, SITE, "/questions/replies", { tls: true, headers: { Cookie: "__Host-csrf=mine" } });
  const t = (r) => (r.headers["set-cookie"] || []).join(";");
  // disk cache: no longer KNOWN (parity rule set-cookie-not-replayed)
  check("site /questions/<word> pages set __Host-csrf for the visitor of the miss; later visitors are not handed that token", /__Host-csrf=token\d+/.test(t(q1)) && t(q2) === "" && t(q3) === "" && cache(q3) === "HIT" && asked(A, "/questions/replies") === 1, `${t(q1)} | ${t(q2)} | ${t(q3)}`);

  // repeated headers
  const d1 = await get(A, host, "/p/dup");
  const d2 = await get(A, host, "/p/dup");
  check("a header Node sends twice (two Link, two X-Dup) is sent twice on a miss and on a hit, in order", rawValues(d1, "link").length === 2 && rawValues(d2, "link").length === 2 && rawValues(d2, "x-dup").join("|") === "one|two" && rawValues(d2, "link").join("|") === "</a.css>; rel=preload; as=style|</b.js>; rel=preload; as=script" && cache(d2) === "HIT", `${rawValues(d1, "link")} // ${rawValues(d2, "link")}`);

  // no Content-Type
  const n1 = await get(A, host, "/p/no-content-type");
  const n2 = await get(A, host, "/p/no-content-type");
  check("a 200 with no Content-Type is served the same on a miss and on a hit", n1.headers["content-type"] === n2.headers["content-type"] && cache(n2) === "HIT" && n2.body.length > 400, `${n1.headers["content-type"]} / ${n2.headers["content-type"]}`);
  // other headers
  const l1 = await get(A, host, "/p/last-modified");
  const l2 = await get(A, host, "/p/last-modified");
  check("Last-Modified and ETag from Node are kept on a hit", l2.headers["last-modified"] === "Wed, 01 Jan 2020 00:00:00 GMT" && l2.headers.etag === '"lm-1"' && l1.headers.etag === '"lm-1"');
  await get(A, host, "/p/content-disposition");
  const cd2 = await get(A, host, "/p/content-disposition");
  check("Content-Disposition is kept on a hit", cd2.headers["content-disposition"] === 'attachment; filename="a b.html"' && cache(cd2) === "HIT");
  const lh = await get(A, host, "/p/long-header");
  const lh2 = await get(A, host, "/p/long-header");
  check("a 6000-byte response header is passed on, miss and hit", lh.status === 200 && lh2.status === 200 && (lh2.headers["x-long"] || "").length === 6000, `${lh.status} ${(lh.headers["x-long"] || "").length}`);
  const em = await get(A, host, "/p/empty");
  const em2 = await get(A, host, "/p/empty");
  check("an empty 200 body is cached and served empty", em.status === 200 && em2.status === 200 && em2.body.length === 0 && cache(em2) === "HIT", `${em.status} ${cache(em2)}`);
  const chunked = await get(A, host, "/p/chunked");
  const chunked2 = await get(A, host, "/p/chunked");
  check("a chunked answer from Node is cached whole", chunked.status === 200 && chunked2.status === 200 && cache(chunked2) === "HIT" && same(chunked, chunked2) && text(chunked2).endsWith("</body>") && text(chunked2).includes("chunk 2"), `${chunked.body.length}`);
});

section("11 large bodies", async () => {
  const host = "s11.localhost";
  const cases = [
    ["3 MB with Content-Length (/large)", "/large"],
    ["3 MB chunked, no Content-Length (/large-chunked)", "/large-chunked"],
    ["3 MB of text/html (/p/large-html)", "/p/large-html"],
  ];
  for (const [label, p] of cases) {
    const before = asked(A, p);
    const first = await get(A, host, p);
    const second = await get(A, host, p);
    check(`${label}: MISS then HIT, whole body both times, Node asked once`, first.status === 200 && second.status === 200 && cache(first) === "MISS" && cache(second) === "HIT" && first.body.length >= 3 * 1024 * 1024 && sha(first.body) === sha(second.body) && asked(A, p) - before === 1, `${first.body.length}/${second.body.length} ${cache(first)}/${cache(second)} asked ${asked(A, p) - before}`);
  }
  const gz = await get(A, host, "/p/large-html", { headers: { "Accept-Encoding": "gzip" } });
  const plain = await get(A, host, "/p/large-html");
  check("the 3 MB html is compressed on request and decodes to the same bytes", gz.headers["content-encoding"] === "gzip" && sha(decode(gz)) === sha(plain.body), `${gz.headers["content-encoding"]}`);
  const siteBefore = asked(A, "/large");
  const site = await get(A, SITE, "/large", { tls: true });
  const site2 = await get(A, SITE, "/large", { h2: true });
  check("site: a 3 MB answer over https and over HTTP/2 is the same body, Node asked once", site.status === 200 && site.body.length > 3 * 1024 * 1024 - 1 && site2.status === 200 && sha(site.body) === sha(site2.body) && asked(A, "/large") - siteBefore === 1, `asked ${asked(A, "/large") - siteBefore}`);
  const large2 = await get(A, host, "/large", { method: "HEAD" });
  check("HEAD of a large hit: Content-Length of the whole file", large2.headers["content-length"] === String(3 * 1024 * 1024));

  // a body that arrives slowly: the client gets it whole, and it is cached
  const slow = await req(A, host, "/slow-stream", { timeout: 20000 });
  check("a slow 2 MB stream from Node arrives whole", slow.status === 200 && slow.body.length === 20 * 100 * 1024, `${slow.status} ${slow.body.length}`);
  await settle();
  const slow2 = await req(A, host, "/slow-stream");
  check("and is a HIT the next time, fast", cache(slow2) === "HIT" && slow2.ms < 2000 && slow2.body.length === slow.body.length, `${cache(slow2)} ${slow2.ms} ms`);
});

section("12 methods and requests that are never cached", async () => {
  const host = "s12.localhost";
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
    const r = await req(A, host, "/post/methods", { method, body: method === "OPTIONS" ? undefined : "x=1" });
    check(`blog ${method}: 403, Node not asked`, r.status === 403 && asked(A, "/post/methods") === 0, String(r.status));
  }
  const wd = await req(A, host, "/post/methods", { method: "PROPFIND" });
  check("a WebDAV method (PROPFIND) is 403", wd.status === 403, String(wd.status));
  const g = await get(A, host, "/post/methods");
  check("the refused methods leave nothing behind: the GET after is a MISS from Node", g.status === 200 && cache(g) === "MISS" && asked(A, "/post/methods") === 1);
  const sp = await req(A, SITE, "/s12/page", { method: "POST", body: "x", tls: true });
  check("site cached location: POST is 403 too", sp.status === 403, String(sp.status));
  const cp = await req(A, "s12.example", "/post/methods", { method: "PUT", body: "x" });
  check("custom domain: PUT is 403", cp.status === 403);

  // webhooks and other site routes: passed through, never cached
  const hook = JSON.stringify({ list_folder: { accounts: ["dbid:1"] } });
  const ho = { method: "POST", body: hook, tls: true, headers: { "Content-Type": "application/json", "X-Dropbox-Signature": "abc" } };
  const h1 = await req(A, SITE, "/clients/dropbox/webhook", ho);
  const h2 = await req(A, SITE, "/clients/dropbox/webhook", ho);
  const e1 = JSON.parse(text(h1));
  check("POST /clients/dropbox/webhook reaches Node with its body and signature, every time, never cached", h1.status === 200 && h2.status === 200 && e1.method === "POST" && e1.bodySha256 === sha(Buffer.from(hook)) && e1.headers["x-dropbox-signature"] === "abc" && cache(h2) === undefined && asked(A, "/clients/dropbox/webhook") === 2, `${h1.status} ${JSON.stringify(e1)}`);
  const g1 = await req(A, SITE, "/clients/google-drive/authenticate?x=1", { tls: true });
  const g2 = await req(A, SITE, "/clients/google-drive/authenticate?x=1", { tls: true });
  check("GET /clients/* (OAuth callbacks) is not cached: Node asked twice", g1.status === 200 && cache(g2) === undefined && asked(A, "/clients/google-drive/authenticate") === 2);
  const big = Buffer.alloc(5 * 1024 * 1024, "z");
  const up = await req(A, SITE, "/clients/icloud/upload", { method: "POST", body: big, tls: true, headers: { "Content-Type": "application/octet-stream" } });
  const upEcho = up.status === 200 ? JSON.parse(text(up)) : {};
  check("a 5 MB upload to /clients/* is passed through whole", up.status === 200 && upEcho.bodyLength === big.length && upEcho.bodySha256 === sha(big), `${up.status} ${text(up).slice(0, 80)}`);
  const git = await req(A, SITE, "/clients/git/end/x.git/git-receive-pack", { method: "POST", body: "0000", tls: true });
  check("git smart HTTP under /clients/git/end/ is passed through", git.status === 200 && JSON.parse(text(git)).method === "POST");
  for (const [label, p, method] of [
    ["POST /stripe-webhook", "/stripe-webhook", "POST"],
    ["POST /paypal-webhook", "/paypal-webhook", "POST"],
    ["GET /redis-health", "/redis-health", "GET"],
    ["GET /dashboard", "/dashboard", "GET"],
    ["POST /dashboard/x", "/dashboard/x", "POST"],
    ["GET /sites/someone", "/sites/someone", "GET"],
    ["POST /sites/someone/rebuild", "/sites/someone/rebuild", "POST"],
    ["POST /sites/log-in", "/sites/log-in", "POST"],
  ]) {
    const o = { method, body: method === "POST" ? "a=1" : undefined, tls: true };
    const a = await req(A, SITE, p, o);
    const b = await req(A, SITE, p, o);
    check(`${label}: passed to Node every time, not cached`, a.status === 200 && b.status === 200 && cache(b) === undefined && asked(A, p) === 2, `${a.status}/${b.status} ${cache(b)} asked ${asked(A, p)}`);
  }
  const bigLogin = await req(A, SITE, "/sites/log-in", { method: "POST", body: "a=".padEnd(5000, "b"), tls: true });
  check("POST /sites/log-in is capped at 4 KB: 413", bigLogin.status === 413, String(bigLogin.status));
  const bigSites = await req(A, SITE, "/sites/someone/upload", { method: "POST", body: big, tls: true });
  check("a 5 MB POST under /sites/<handle> is allowed", bigSites.status === 200, String(bigSites.status));
  for (const p of ["/questions/12", "/questions/ask", "/news/sign-up", "/news/cancel", "/questions/12/edit", "/questions/12/new"]) {
    const a = await req(A, SITE, p, { tls: true });
    const b = await req(A, SITE, p, { tls: true });
    check(`site ${p}: not cached (csrf), Node asked twice`, a.status === 200 && cache(a) === undefined && cache(b) === undefined && asked(A, p) === 2, `${cache(b)} asked ${asked(A, p)}`);
  }
  const rand1 = await req(A, host, "/random");
  const rand2 = await req(A, host, "/random");
  check("blog /random bypasses the cache: 302 with no-cache from Node, asked every time", rand1.status === 302 && rand1.headers["cache-control"] === "no-cache" && cache(rand2) === undefined && asked(A, "/random") === 2);
  const cdn = await req(A, SITE, "/cdn/fonts/x.woff2", { tls: true });
  check("site /cdn/<path> redirects to cdn.blot.im/<path>", cdn.status === 301 && cdn.headers.location === "https://cdn.blot.im/fonts/x.woff2" && asked(A, "/cdn/fonts/x.woff2") === 0, `${cdn.status} ${cdn.headers.location}`);
  const health = await req(A, host, "/health");
  const sh2 = await req(A, SITE, "/health", { tls: true });
  check("/health is answered by the proxy on blogs and the site (200, Node not asked)", health.status === 200 && sh2.status === 200 && asked(A, "/health") === 0);
  const sig = await req(A, host, "/files/signal.pdf");
  check("/files/signal.pdf is redirected to the CDN by the proxy", sig.status === 301 && /^https:\/\/cdn\.blot\.im\//.test(sig.headers.location || ""));

  // blocked before Node
  const php = await req(A, host, "/wp-login.php");
  const env = await tryReq(A, host, "/.env");
  const git2 = await tryReq(A, host, "/.git/config");
  const adm = await req(A, host, "/admin/login");
  check("scanner paths never reach Node: .php and /admin/ are 403, .env and .git close the connection (444)", php.status === 403 && adm.status === 403 && env.status === 0 && git2.status === 0 && asked(A, "/wp-login.php") === 0 && asked(A, "/.env") === 0, `${php.status} ${adm.status} ${env.status} ${git2.status}`);
  const bot = await req(A, host, "/post/bot", { headers: { "User-Agent": "python-requests/2" } });
  check("a blocked user agent gets 403 on a cached location, Node not asked", bot.status === 403 && asked(A, "/post/bot") === 0);
  const noua = await req(A, host, "/post/bot", { headers: { "User-Agent": "" } });
  check("an empty user agent is not blocked on a cached location (200)", noua.status === 200, String(noua.status));
});

section("13 SSE streams are streamed, not buffered, not cached", async () => {
  const stream = async (label, host, p, o) => {
    const before = asked(A, p);
    const r1 = await req(A, host, p, o);
    const r2 = await req(A, host, p, o);
    const events = (text(r1).match(/^data: /gm) || []).length;
    check(
      `${label}: first byte at once, stream lasts ~1.5 s, six events, Node asked each time, never cached`,
      r1.status === 200 && /text\/event-stream/.test(r1.headers["content-type"] || "") && r1.firstByteMs < 700 && r1.ms > 1200 && events === 6 && cache(r1) !== "HIT" && cache(r2) !== "HIT" && asked(A, p) - before === 2,
      `${r1.status} first ${r1.firstByteMs} ms total ${r1.ms} ms events ${events} asked ${asked(A, p) - before}`
    );
  };
  await stream("/draft/stream/<file> on a blog", "s13.localhost", "/draft/stream/abc");
  await stream("/draft/stream/<file> on a custom domain", "s13.example", "/draft/stream/abc");
  await stream("/sites/<handle>/status on the site (HTTP/1.1)", SITE, "/sites/s13/status", { tls: true });
  await stream("/sites/<handle>/status on the site (HTTP/2)", SITE, "/sites/s13h2/status", { h2: true });
  await stream("/__blot/preview/reload on a preview host", "preview-s13.localhost", "/__blot/preview/reload");
  await stream("/__blot/preview/reload on a blog host (the cached location; Node's X-Accel-Buffering: no keeps it out of the cache)", "s13c.localhost", "/__blot/preview/reload");
  const aborted = await new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port: A.http, path: "/draft/stream/abort", headers: { Host: "s13.localhost" }, agent: false }, (res) => {
      res.once("data", () => {
        r.destroy();
        resolve(true);
      });
    });
    r.on("error", () => {});
    r.end();
  });
  check("a client that disconnects mid-stream does not break the next request", aborted && (await req(A, "s13.localhost", "/post/after-abort")).status === 200);
});

section("14 purge", async () => {
  const pages = ["/post/x-a", "/post/x-b"];
  const hosts = ["p1.localhost", "p2.localhost", "p3.localhost"];
  for (const h of hosts) for (const p of pages) await get(A, h, p);
  const state = async () => {
    const out = {};
    for (const h of hosts) out[h] = (await Promise.all(pages.map((p) => req(A, h, p)))).map(cache).join("/");
    await settle();
    return out;
  };
  let s = await state();
  check("filled: every page is a HIT", hosts.every((h) => s[h] === "HIT/HIT"), JSON.stringify(s));

  let r = purge(A, ["p1.localhost"]);
  check("purge of one host answers 200 and names the host", r.code === 200 && /p1\.localhost/.test(r.text), `${r.code} ${r.text}`);
  s = await state();
  check("after purging p1: its pages are MISS, p2 and p3 untouched (HIT)", s["p1.localhost"] === "MISS/MISS" && s["p2.localhost"] === "HIT/HIT" && s["p3.localhost"] === "HIT/HIT", JSON.stringify(s));
  s = await state();
  check("and p1 is cached again from the refill", s["p1.localhost"] === "HIT/HIT");

  r = purge(A, ["p2.localhost", "p3.localhost"]);
  check("purge of two hosts in one call answers 200 and names both", r.code === 200 && /p2\.localhost/.test(r.text) && /p3\.localhost/.test(r.text), r.text);
  s = await state();
  check("after purging p2 and p3: both MISS, p1 untouched", s["p2.localhost"] === "MISS/MISS" && s["p3.localhost"] === "MISS/MISS" && s["p1.localhost"] === "HIT/HIT", JSON.stringify(s));

  r = purge(A, ["never-cached.localhost"]);
  check("purge of a host with nothing cached: 200", r.code === 200, `${r.code} ${r.text}`);
  r = purge(A, []);
  check("purge with no host: 200, nothing purged, others still cached", r.code === 200 && (await state())["p1.localhost"] === "HIT/HIT", `${r.code} ${r.text}`);

  // one purge covers http and https of a host, the query-string variants, and the compressed forms
  const h = "p4.localhost";
  await get(A, h, "/post/v?a=1");
  await get(A, h, "/post/v?a=2");
  await get(A, h, "/post/v", { tls: true });
  await get(A, h, "/style.css", { headers: { "Accept-Encoding": "br" } });
  await get(A, h, "/style.css", { headers: { "Accept-Encoding": "gzip" } });
  await sleep(1500);
  purge(A, [h]);
  const after = [await req(A, h, "/post/v?a=1"), await req(A, h, "/post/v?a=2"), await req(A, h, "/post/v", { tls: true }), await req(A, h, "/style.css", { headers: { "Accept-Encoding": "gzip" } })];
  check("one purge removes every entry of the host: query variants, https, and the compressed copies", after.every((x) => cache(x) === "MISS"), after.map(cache).join(","));

  await get(A, SITE, "/s14/page", { tls: true });
  await get(A, "p5.example", "/post/c");
  purge(A, [SITE]);
  const siteAfter = await req(A, SITE, "/s14/page", { tls: true });
  const customAfter = await req(A, "p5.example", "/post/c");
  check("purging the site's host refills the site page; the custom domain is untouched", cache(siteAfter) === "MISS" && cache(customAfter) === "HIT", `${cache(siteAfter)} ${cache(customAfter)}`);
  purge(A, ["p5.example"]);
  check("purging a custom domain refills it", cache(await req(A, "p5.example", "/post/c")) === "MISS");

  const before = asked(A, "/post/p6");
  await get(A, "p6.localhost", "/post/p6");
  purge(A, ["p6.localhost"]);
  await get(A, "p6.localhost", "/post/p6");
  check("a purge makes the next request ask Node again (once)", asked(A, "/post/p6") - before === 2);

  // purge token
  const th = "pt.localhost";
  await get(T, th, "/post/t");
  const no = purge(T, [th]);
  const bad = purge(T, [th], "wrong");
  const empty = purge(T, [th], "");
  check("token set: purge without the token, with a wrong one and with an empty one are all 403", no.code === 403 && bad.code === 403 && empty.code === 403, `${no.code} ${bad.code} ${empty.code}`);
  check("and nothing was purged by the refused calls", cache(await req(T, th, "/post/t")) === "HIT");
  const ok = purge(T, [th], "secret");
  check("token set: purge with the right token is 200 and purges", ok.code === 200 && cache(await req(T, th, "/post/t")) === "MISS", `${ok.code}`);
  await get(A, "pt.localhost", "/post/t");
  const open = purge(A, ["pt.localhost"], "anything");
  check("no token configured: purge is open (a token header is ignored)", open.code === 200 && cache(await req(A, "pt.localhost", "/post/t")) === "MISS", String(open.code));
});

section("15 simultaneous misses", async () => {
  const host = "s15.localhost";
  const p = "/p/slow";
  const out = await Promise.all(Array.from({ length: 10 }, () => req(A, host, p + "?coalesce=1")));
  check("ten simultaneous misses of a page that takes 1.5 s: all 200 with the same body", out.every((r) => r.status === 200 && same(r, out[0])), out.map((r) => r.status).join(","));
  check("Node was asked once for the ten", asked(A, p) === 1, String(asked(A, p)));
  const labels = out.map(cache).sort();
  check("one request was the MISS; the others waited and were served from the entry", labels.filter((s) => s === "MISS").length === 1, labels.join(","));
  const site = await Promise.all(Array.from({ length: 10 }, () => req(A, SITE, p + "?site=1", { tls: true })));
  check("site: ten simultaneous misses ask Node once", site.every((r) => r.status === 200) && asked(A, p) === 2, `asked ${asked(A, p)}`);
  const nf = await Promise.all(Array.from({ length: 5 }, () => req(A, host, "/p/status/404?coalesce=1")));
  check("simultaneous misses of a 404 give everybody the 404", nf.every((r) => r.status === 404));
  const uncached = await Promise.all(Array.from({ length: 6 }, () => req(A, host, "/p/status/403?coalesce=1")));
  check("simultaneous requests for a page that is never cached (403) all get the 403", uncached.every((r) => r.status === 403));
});

section("16 what Node receives", async () => {
  const host = "s16.localhost";
  const r = await req(A, host, "/p/echo?x=1", { headers: { Cookie: "sid=abc", Authorization: "Bearer t", "Accept-Language": "fr", Referer: "http://ref.example/", "X-Forwarded-For": "6.6.6.6" } });
  const e = echoOf(r);
  check("Host, scheme and the client's address reach Node (X-Forwarded-Proto, X-Real-IP, X-Request-ID)", e.headers.host === host && e.headers["x-forwarded-proto"] === "http" && e.headers["x-real-ip"] === "(present)" && e.headers["x-request-id"] === "(present)", JSON.stringify(e.headers));
  check("X-Forwarded-For is present (a client's own value is kept and the peer appended)", e.headers["x-forwarded-for"] === "(present)");
  check("Cookie, Authorization, Accept-Language and Referer are passed to Node on a miss", e.headers.cookie === "sid=abc" && e.headers.authorization === "Bearer t" && e.headers["accept-language"] === "fr" && e.headers.referer === "http://ref.example/");
  const ae = await req(A, host, "/p/echo?y=1", { headers: { "Accept-Encoding": "gzip, br" } });
  check("a client's Accept-Encoding does not reach Node (the proxy compresses)", !echoOf(ae).headers["accept-encoding"]);
  check("the request line reaches Node as sent (path and query)", e.url === "/p/echo?x=1" && e.method === "GET", e.url);
  const t = await req(A, host, "/p/echo?z=1", { tls: true });
  check("over https: X-Forwarded-Proto: https", echoOf(t).headers["x-forwarded-proto"] === "https");
  const s = await req(A, SITE, "/p/echo", { h2: true });
  const se = echoOf(s);
  check("HTTP/2 to the site arrives at Node as HTTP/1.1 with Host and X-Forwarded-Proto: https", se.headers.host === "localhost" && se.headers["x-forwarded-proto"] === "https", JSON.stringify(se.headers));
  const web = await req(A, "preview-s16.localhost", "/p/echo", { headers: { Cookie: "sid=abc" } });
  check("the preview host passes the Cookie to Node", echoOf(web).headers.cookie === "sid=abc");
});

section("17 rate limit page", async () => {
  const host = "s17.localhost";
  const first = await req(RL, host, "/post/rl");
  check("with the rate limits on, a single request is served normally", first.status === 200, String(first.status));
  const rs = await Promise.all(Array.from({ length: 90 }, () => tryReq(RL, host, "/post/rl")));
  const limited = rs.find((r) => r.status === 429);
  const counts = rs.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
  check("hammering a cached URL past the burst gets 429", !!limited, JSON.stringify(counts));
  if (limited) {
    check("the 429 body is the blog offline page, not nginx's bare 429", text(limited) === offlineBlog(), text(limited).slice(0, 80));
    check("the 429 is not cached: no HIT on it", cache(limited) !== "HIT");
  }
  check("the burst is answered only with 200 and 429 (no 5xx, no dropped connections)", Object.keys(counts).every((s) => s === "200" || s === "429"), JSON.stringify(counts));
  check("requests inside the limit are served whole from the entry", rs.filter((r) => r.status === 200).length >= 20 && rs.filter((r) => r.status === 200).every((r) => r.body.length > 500));
  const siteRs = await Promise.all(Array.from({ length: 90 }, () => tryReq(RL, SITE, "/s17/page", { tls: true })));
  const siteLimited = siteRs.find((r) => r.status === 429);
  check("site: the 429 page is the site's offline page", !!siteLimited && text(siteLimited) === offlineSite(), siteLimited ? text(siteLimited).slice(0, 60) : "no 429");
  await sleep(6000);
  const later = await req(RL, host, "/post/rl");
  check("after the burst the same URL is served again (200)", later.status === 200, String(later.status));
  const rand = await Promise.all(Array.from({ length: 90 }, () => tryReq(RL, "s17b.localhost", "/random")));
  check("an uncached location (/random) is rate limited too", rand.some((r) => r.status === 429));
});

// ---- main ---------------------------------------------------------------

async function main() {
  cleanup();
  try {
    await Promise.all(ALL.map(startProxy));
    console.log(`containers up in ${Math.round((Date.now() - started) / 1000)} s`);
    for (const s of sections) {
      if (ONLY && !ONLY.test(s.name)) continue;
      console.log(`\n== ${s.name}`);
      const before = passes + failures;
      const t0 = Date.now();
      try {
        await s.fn();
      } catch (e) {
        failures++;
        failed.push(s.name + " (section crashed)");
        console.log("  FAIL - section crashed:", e && e.stack ? e.stack : e);
      }
      console.log(`   (${passes + failures - before} checks, ${Math.round((Date.now() - t0) / 100) / 10} s)`);
    }
  } finally {
    if (process.env.RM_KEEP !== "1") cleanup();
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`\n${passes} passed, ${failures} failed (${known.length} KNOWN), ${seconds} s`);
  if (known.length) {
    console.log("\nKNOWN behaviours asserted as they are today:");
    for (const k of known) console.log("  " + k);
  }
  if (failures) {
    console.log("\nfailed:");
    for (const f of failed) console.log("  " + f);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  if (process.env.RM_KEEP !== "1") cleanup();
  process.exit(1);
});
