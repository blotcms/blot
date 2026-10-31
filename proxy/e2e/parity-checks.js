// Differential parity test: the proxy built from a base ref (origin/master by
// default) against the proxy built from the working tree. The same request
// corpus goes to both, in the same order, and status, decoded body and
// headers are compared. On master the two are the same code, so the run must
// show 0 differences; it guards later proxy PRs, which list each change they
// make to what a client sees in INTENDED below, with a reason. Plain node, no
// dependencies. Run by the proxy-parity job in
// .github/workflows/integration.yml after request-matrix.js; locally:
//
//   node proxy/e2e/parity-checks.js
//
// It builds both images itself unless they exist (PARITY_BUILD=1 forces a
// rebuild): the baseline from a temporary git worktree of the base ref (its
// own proxy/build renders its own config), the other from the working tree.
// Environment:
//
//   PARITY_BASE      git ref of the baseline          (default origin/master)
//   PARITY_BUILD     1: rebuild both images even if present
//   PARITY_VERBOSE   1: print every difference, intended ones too
//   PARITY_PORT_BASE first of the host ports used     (default 18090)
//   PARITY_PREFIX    container / volume name prefix   (default pa)
//   PARITY_BASE_IMAGE, PARITY_TREE_IMAGE   image tags to use or build
//   PARITY_KEEP      1: leave the containers running afterwards
//
// Containers (prefix-base and prefix-tree), each with the stub upstream
// (proxy/e2e/stub-upstream.js, STUB_PARITY=1: deterministic echo bodies) in
// its network namespace. Every client address is on the rate-limit whitelist,
// as in request-matrix.js.
//
// The passes: miss, hit, purge, refill, hit, hit again after the compressed
// copies exist, Node stopped (cached pages are still served, the rest get the
// offline page), Node back. A difference that is not in INTENDED below fails
// the run; see proxy/e2e/parity/AUDIT.md for what each request kind is.

const http = require("http");
const http2 = require("http2");
const https = require("https");
const net = require("net");
const zlib = require("zlib");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "../..");
const STUB = path.join(__dirname, "stub-upstream.js");
const BASE_REF = process.env.PARITY_BASE || "origin/master";
const PORT = parseInt(process.env.PARITY_PORT_BASE || "18090", 10);
const VERBOSE = process.env.PARITY_VERBOSE === "1";
const CACHE = "/var/cache/openresty";
const FILTER = process.env.PARITY_GROUPS ? new RegExp(process.env.PARITY_GROUPS) : null;
const DUMP = process.env.PARITY_DUMP;

const PREFIX = process.env.PARITY_PREFIX || "pa";
const M = { name: PREFIX + "-base", image: process.env.PARITY_BASE_IMAGE || "blot-proxy:parity-base", http: PORT, https: PORT + 1, volume: PREFIX + "-cache-base" };
const B = { name: PREFIX + "-tree", image: process.env.PARITY_TREE_IMAGE || "blot-proxy:parity-tree", http: PORT + 2, https: PORT + 3, volume: PREFIX + "-cache-tree" };

const started = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  for (const c of [M, B]) dockerTry("rm", "-f", c.name + "-stub", c.name);
  for (const c of [M, B]) dockerTry("volume", "rm", "-f", c.volume);
}

function imageExists(tag) {
  try {
    docker("image", "inspect", tag);
    return true;
  } catch (e) {
    return false;
  }
}

// Render the config with the tree's own proxy/build and build the image
function buildImage(tree, tag) {
  console.log(`building ${tag} from ${tree}`);
  const gen = process.env.PARITY_GENDEPS || fs.mkdtempSync(path.join(os.tmpdir(), "parity-gendeps-"));
  if (!fs.existsSync(path.join(gen, "node_modules", "mustache"))) {
    fs.mkdirSync(gen, { recursive: true });
    execFileSync("npm", ["init", "-y"], { cwd: gen, stdio: "ignore" });
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "mustache@4.2.0", "fs-extra@11.1.0"], { cwd: gen, stdio: "ignore" });
  }
  execFileSync("bash", ["proxy/build/build.sh"], {
    cwd: tree,
    stdio: "ignore",
    env: {
      ...process.env,
      BLOT_HOST: "localhost",
      FETCH_CDN_IPS: "false",
      NODE_PATH: path.join(gen, "node_modules") + ":" + path.join(tree, "app"),
    },
  });
  execFileSync("bash", [path.join(REPO, "proxy/build/image.sh"), tag], { cwd: tree, stdio: "ignore" });
}

function buildImages() {
  const force = process.env.PARITY_BUILD === "1";
  if (force || !imageExists(B.image)) buildImage(REPO, B.image);
  if (force || !imageExists(M.image)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "parity-base-"));
    try {
      execFileSync("git", ["worktree", "add", "--detach", "-f", dir, BASE_REF], { cwd: REPO, stdio: "ignore" });
      buildImage(dir, M.image);
    } finally {
      spawnSync("git", ["worktree", "remove", "--force", dir], { cwd: REPO, stdio: "ignore" });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function waitFor(fn, timeoutMs = 10000, everyMs = 200) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) return value;
    await sleep(everyMs);
  }
}

async function startProxy(c) {
  docker("run", "-d", "--name", c.name, "-p", `${c.http}:80`, "-p", `${c.https}:443`, "-e", "BLOT_HOST=localhost", "-e", "PROXY_UNIT_MAIN=127.0.0.1:8090", "-e", "PROXY_UNIT_WORKER=127.0.0.1:8089", "-e", "PROXY_PEER_MAIN=127.0.0.1:8088", "-e", "PROXY_PEER_WORKER=127.0.0.1:8088", "-v", `${c.volume}:${CACHE}`, c.image);
  startStub(c);
  const proxyUp = await waitFor(async () => (await send(c, { host: "ready.example", path: "/health" }).catch(() => ({}))).status === 200, 40000, 500);
  if (!proxyUp) throw new Error(c.name + ": proxy did not come up\n" + dockerTry("logs", c.name));
  // every address on the geo whitelist: no per-client rate or connection limits
  sh(c, "printf '0.0.0.0/0 1;\\n::/0 1;\\n' > /etc/openresty/cdn-ips.conf && /usr/local/openresty/bin/openresty -s reload");
  await sleep(1500);
  // the baseline's purge answers 503 until its index is built
  const ready = await waitFor(() => purge(c, ["ready.example"]).code === 200, 60000, 500);
  if (!ready) throw new Error(c.name + ": purge never became ready");
}

function startStub(c) {
  docker("run", "-d", "--name", c.name + "-stub", "--network", "container:" + c.name, "-e", "STUB_PARITY=1", "-v", `${STUB}:/s.js:ro`, "node:24.22.1-alpine", "node", "/s.js");
}

async function waitStub(c) {
  const up = await waitFor(() => {
    try {
      sh(c, "wget -qO- -T1 http://127.0.0.1:8090/ >/dev/null 2>&1");
      return true;
    } catch (e) {
      return false;
    }
  }, 40000, 500);
  if (!up) throw new Error(c.name + ": stub did not come up");
}

function purge(c, hosts) {
  const query = hosts.map((h) => "host=" + h).join("&");
  const out = sh(c, `curl -s -m 20 -w '\\n%{http_code}' 'http://127.0.0.1/purge?${query}'`);
  const lines = out.trimEnd().split("\n");
  return { code: parseInt(lines.pop(), 10), text: lines.join("\n") };
}

// The stubs are restarted for the "Node back" pass: retry while one is
// still starting
function stubCounts(c) {
  for (let i = 0; ; i++) {
    try {
      return JSON.parse(sh(c, "wget -qO- -T2 http://127.0.0.1:8088/__counts"));
    } catch (e) {
      if (i === 20) throw e;
      execFileSync("sleep", ["0.5"]);
    }
  }
}

// ---- requests -----------------------------------------------------------

// A response: { status, raw: [[lower-case name, value]...], body, firstByteMs }
function fromNode(res, chunks, started, firstByte) {
  const raw = [];
  for (let i = 0; i < res.rawHeaders.length; i += 2) raw.push([res.rawHeaders[i].toLowerCase(), res.rawHeaders[i + 1]]);
  return { status: res.statusCode, raw, body: Buffer.concat(chunks), ms: Date.now() - started, firstByteMs: firstByte };
}

function sendH1(c, spec) {
  const started = Date.now();
  const tls = !!spec.tls;
  const options = {
    method: spec.method || "GET",
    host: "127.0.0.1",
    port: tls ? c.https : c.http,
    path: spec.path,
    agent: false,
    headers: { Host: spec.host, "User-Agent": "Mozilla/5.0 (compatible; parity-checks)", ...(spec.headers || {}) },
    rejectUnauthorized: false,
    servername: tls ? spec.host.replace(/:\d+$/, "") : undefined,
    timeout: 30000,
    insecureHTTPParser: true,
  };
  if (spec.body !== undefined) options.headers["Content-Length"] = Buffer.byteLength(spec.body);
  return new Promise((resolve, reject) => {
    const r = (tls ? https : http).request(options, (res) => {
      const chunks = [];
      let firstByte = null;
      res.on("data", (d) => {
        if (firstByte === null) firstByte = Date.now() - started;
        chunks.push(d);
      });
      res.on("end", () => resolve(fromNode(res, chunks, started, firstByte)));
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("aborted")));
    });
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", reject);
    r.end(spec.body);
  });
}

function sendH2(c, spec) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const authority = spec.host;
    const session = http2.connect(`https://127.0.0.1:${c.https}`, { rejectUnauthorized: false, servername: authority.replace(/:\d+$/, "") });
    session.on("error", reject);
    const headers = {
      ":method": spec.method || "GET",
      ":path": spec.path,
      ":authority": authority,
      "user-agent": "Mozilla/5.0 (compatible; parity-checks)",
      ...Object.fromEntries(Object.entries(spec.headers || {}).map(([k, v]) => [k.toLowerCase(), v])),
    };
    const stream = session.request(headers);
    const chunks = [];
    let res = null;
    let firstByte = null;
    stream.on("response", (h, flags) => {
      res = h;
    });
    stream.on("data", (d) => {
      if (firstByte === null) firstByte = Date.now() - started;
      chunks.push(d);
    });
    stream.on("end", () => {
      const raw = [];
      for (const [k, v] of Object.entries(res)) {
        if (k === ":status") continue;
        for (const one of Array.isArray(v) ? v : [v]) raw.push([k.toLowerCase(), String(one)]);
      }
      session.close();
      resolve({ status: res[":status"], raw, body: Buffer.concat(chunks), ms: Date.now() - started, firstByteMs: firstByte });
    });
    stream.on("error", (e) => {
      session.close();
      reject(e);
    });
    stream.setTimeout(30000, () => stream.close());
    stream.end(spec.body);
  });
}

// Bytes on a socket, for URLs Node's client refuses to send (raw non-ASCII)
function sendRaw(c, spec) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const sock = net.connect(c.http, "127.0.0.1");
    const parts = [];
    sock.on("connect", () => {
      sock.write(Buffer.concat([Buffer.from(`${spec.method || "GET"} `), Buffer.from(spec.path, "latin1"), Buffer.from(` HTTP/1.1\r\nHost: ${spec.host}\r\nUser-Agent: Mozilla/5.0 (compatible; parity-checks)\r\nConnection: close\r\n\r\n`)]));
    });
    sock.on("data", (d) => parts.push(d));
    sock.setTimeout(30000, () => sock.destroy(new Error("timeout")));
    sock.on("error", reject);
    sock.on("close", () => {
      const all = Buffer.concat(parts);
      const end = all.indexOf("\r\n\r\n");
      if (end < 0) return resolve({ status: 0, raw: [], body: all, ms: Date.now() - started });
      const lines = all.subarray(0, end).toString("latin1").split("\r\n");
      const status = parseInt(lines[0].split(" ")[1], 10);
      const raw = lines.slice(1).map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]);
      let body = all.subarray(end + 4);
      if (raw.some(([k, v]) => k === "transfer-encoding" && /chunked/i.test(v))) {
        const out = [];
        let i = 0;
        for (;;) {
          const eol = body.indexOf("\r\n", i);
          const size = parseInt(body.subarray(i, eol).toString(), 16);
          if (!size) break;
          out.push(body.subarray(eol + 2, eol + 2 + size));
          i = eol + 2 + size + 2;
        }
        body = Buffer.concat(out);
      }
      resolve({ status, raw, body, ms: Date.now() - started });
    });
  });
}

function send(c, spec) {
  if (spec.raw) return sendRaw(c, spec);
  if (spec.h2) return sendH2(c, spec);
  return sendH1(c, spec);
}

// ---- the corpus ---------------------------------------------------------

const BLOG = "parity.localhost";
const BLOG2 = "second.localhost";
const CUSTOM = "custom.example";
const SITE = "localhost";
const PREVIEW = "preview-parity.localhost";
const CDN = "cdn.localhost";

// Every host a cached location can see, for the purge
const CACHED_HOSTS = [BLOG, BLOG2, CUSTOM, SITE, "127.0.0.1", "ready.example"];

function corpus() {
  const list = [];
  let n = 0;
  const add = (group, spec) => list.push({ id: `${group}#${++n} ${spec.method || "GET"} ${spec.host}${spec.path.length > 90 ? spec.path.slice(0, 90) + "..." : spec.path}${spec.headers ? " " + JSON.stringify(spec.headers) : ""}`, group, ...spec });

  // --- blog pages, every kind of document a blog serves, cached
  for (const p of [
    "/", "/page/2", "/2024/01/hello-world", "/tagged/news", "/tagged/news/page/2", "/archive", "/about",
    "/search?q=blot", "/search?q=hello%20world", "/feed.rss", "/feed.json", "/sitemap.xml", "/robots.txt", "/style.css", "/script.js",
    "/data.json", "/logo.svg", "/photo.jpg", "/notes.txt", "/font.woff2", "/doc.pdf", "/_assets/ab12cd/photo.jpg", "/_image_cache/ab/photo.jpg",
    "/folder/files/doc.pdf", "/verify/domain-setup", "/draft/view/draft.txt", "/random-page", "/.well-known/security.txt",
    "/favicon.ico", "/humans.txt", "/ads.txt",
  ]) {
    add("blog", { host: BLOG, path: p });
  }
  add("blog", { host: BLOG2, path: "/" });
  add("blog", { host: BLOG2, path: "/style.css" });

  // --- statuses Node answers with
  for (const code of [200, 301, 302, 307, 308, 400, 401, 403, 404, 410, 429, 500, 502, 503, 504]) {
    add("status", { host: BLOG, path: `/p/status/${code}` });
    add("status", { host: CUSTOM, path: `/p/status/${code}` });
  }
  add("status", { host: BLOG, path: "/redirect-301" });
  add("status", { host: BLOG, path: "/redirect-302" });
  add("status", { host: BLOG, path: "/notfound-page" });
  add("status", { host: BLOG, path: "/boom" });
  add("status", { host: BLOG, path: "/unavailable" });
  add("status", { host: BLOG, path: "/anything?stub-status=404" });
  add("status", { host: BLOG, path: "/anything?stub-status=200" });

  // --- query strings and URL forms: each a different entry
  for (const p of [
    "/q?a=1", "/q?a=2", "/q?a=1&b=2", "/q?b=2&a=1", "/q?", "/q", "/q?utm_source=x", "/q?a=%20b", "/q?a=+b", "/q?a=%2B", "/q?a[]=1&a[]=2",
    "/q?x=" + "y".repeat(2000), "/caf%C3%A9", "/caf%c3%a9", "/a%2Fb", "/a%20b", "/a+b", "/%7Euser", "/a//b", "/a/./b", "/a/../b", "/a/b/", "/a/b",
    "/%E2%9C%93-check", "/emoji-%F0%9F%98%80", "/q?name=caf%C3%A9", "/semi;colon", "/hash%23tag", "/q?a=1#frag", "/UPPER/Case", "/a%00b", "/a%zzb",
    "/" + "long-segment-".repeat(500), "/q?" + "k=v&".repeat(1000),
  ]) {
    add("url", { host: BLOG, path: p });
  }
  add("url", { host: BLOG, path: "/café", raw: true });
  add("url", { host: BLOG, path: Buffer.from("/café", "utf8").toString("latin1"), raw: true });
  add("url", { host: BLOG, path: "/q?name=" + Buffer.from("café", "utf8").toString("latin1"), raw: true });
  add("url", { host: BLOG, path: "/" + "z".repeat(9000) });
  add("url", { host: BLOG, path: "*" , raw: true, method: "OPTIONS" });
  // host spellings of one blog share a key
  add("host", { host: "PARITY.localhost", path: "/host-case" });
  add("host", { host: "parity.localhost", path: "/host-case" });
  add("host", { host: "parity.localhost:80", path: "/host-case" });
  add("host", { host: "parity.localhost.", path: "/host-case" });
  add("host", { host: "127.0.0.1", path: "/by-ip" });
  add("host", { host: "ready.example", path: "/health" });

  // --- request headers the cache must not (or must) care about
  const AE = ["br", "gzip", "gzip, br", "br, gzip", "deflate", "identity", "br;q=0", "gzip;q=0, br", "br;q=0.1, gzip;q=0.9", "*", "*;q=0", "BR", "zstd, br", "gzip, deflate, br, zstd", ""];
  for (const ae of AE) add("accept-encoding", { host: BLOG, path: "/ae.html", headers: { "Accept-Encoding": ae } });
  for (const ae of ["br", "gzip", "gzip, br"]) {
    add("accept-encoding", { host: BLOG, path: "/ae.css", headers: { "Accept-Encoding": ae } });
    add("accept-encoding", { host: BLOG, path: "/ae.json", headers: { "Accept-Encoding": ae } });
    add("accept-encoding", { host: BLOG, path: "/ae.jpg", headers: { "Accept-Encoding": ae } });
    add("accept-encoding", { host: BLOG, path: "/ae.svg", headers: { "Accept-Encoding": ae } });
    add("accept-encoding", { host: BLOG, path: "/p/chunked", headers: { "Accept-Encoding": ae } });
    add("accept-encoding", { host: BLOG, path: "/p/empty", headers: { "Accept-Encoding": ae } });
  }
  add("headers", { host: BLOG, path: "/hdr", headers: { Cookie: "a=1; b=2", Authorization: "Bearer abc" } });
  add("headers", { host: BLOG, path: "/hdr", headers: { Cookie: "different=1" } });
  add("headers", { host: BLOG, path: "/hdr-upgrade", headers: { Upgrade: "websocket", Connection: "Upgrade" } });
  add("headers", { host: BLOG, path: "/hdr-xff", headers: { "X-Forwarded-For": "1.2.3.4", "X-Forwarded-Proto": "https", "X-Real-IP": "5.6.7.8", "X-Forwarded-Host": "evil.example" } });
  add("headers", { host: BLOG, path: "/hdr-lang", headers: { "Accept-Language": "fr", Accept: "application/json", Origin: "https://x.example", Referer: "https://x.example/" } });
  add("headers", { host: BLOG, path: "/hdr-cc", headers: { "Cache-Control": "no-cache", Pragma: "no-cache" } });
  add("headers", { host: BLOG, path: "/hdr-cc", headers: { "Cache-Control": "max-age=0" } });
  add("headers", { host: BLOG, path: "/hdr-ua", headers: { "User-Agent": "Googlebot/2.1" } });
  add("headers", { host: BLOG, path: "/hdr-ua-bad", headers: { "User-Agent": "python-requests/2.0" } });
  add("headers", { host: BLOG, path: "/hdr-ua-empty", headers: { "User-Agent": "" } });
  add("headers", { host: BLOG, path: "/hdr-te", headers: { TE: "trailers" } });

  // --- what Node adds: headers, cookies, caching directives
  for (const p of ["/p/set-cookie", "/p/cache-control", "/p/cache-control-long", "/p/vary", "/p/dup", "/p/last-modified", "/p/weak-etag", "/p/strong-etag", "/etag-page", "/p/long-header", "/p/content-disposition", "/p/empty", "/p/no-content-type", "/p/chunked", "/p/large-html", "/large", "/large-chunked", "/p/ranged.bin"]) {
    add("node-headers", { host: BLOG, path: p });
    add("node-headers", { host: CUSTOM, path: p });
  }
  add("node-headers", { host: SITE, path: "/p/set-cookie", tls: true });
  add("node-headers", { host: SITE, path: "/questions/replies", tls: true });
  add("node-headers", { host: SITE, path: "/p/vary", tls: true, h2: true });

  // --- HEAD
  for (const p of ["/head.html", "/p/strong-etag", "/p/status/404", "/p/status/301", "/p/status/500", "/p/empty", "/large", "/p/set-cookie", "/p/dup", "/p/last-modified", "/head-after-get.html"]) {
    add("head", { host: BLOG, path: p, method: "HEAD" });
  }
  // a GET after a HEAD of the same page: the baseline's HEAD filled the cache
  add("head", { host: BLOG, path: "/head-after-get.html", afterHead: true });
  add("head", { host: BLOG, path: "/head-after-get.html", method: "HEAD" });
  add("head", { host: BLOG, path: "/head.html", method: "HEAD", headers: { "Accept-Encoding": "br" } });
  add("head", { host: BLOG, path: "/head.html", afterHead: true });
  add("head", { host: BLOG, path: "/head.html", method: "HEAD", headers: { "Accept-Encoding": "gzip" } });
  add("head", { host: SITE, path: "/head-site.html", method: "HEAD", tls: true });

  // --- conditional requests
  const cond = (path, headers) => add("conditional", { host: BLOG, path, headers });
  for (const p of ["/p/strong-etag", "/etag-page", "/p/weak-etag", "/p/last-modified"]) {
    cond(p, {});
    cond(p, { "If-None-Match": '"strong-1"' });
    cond(p, { "If-None-Match": 'W/"strong-1"' });
    cond(p, { "If-None-Match": '"node-etag-1"' });
    cond(p, { "If-None-Match": 'W/"node-etag-1"' });
    cond(p, { "If-None-Match": 'W/"weak-1"' });
    cond(p, { "If-None-Match": '"lm-1"' });
    cond(p, { "If-None-Match": '"nope"' });
    cond(p, { "If-None-Match": '"nope", "strong-1", "node-etag-1", W/"weak-1", "lm-1"' });
    cond(p, { "If-None-Match": "*" });
    cond(p, { "If-None-Match": '"strong-1"', "Accept-Encoding": "br" });
    cond(p, { "If-None-Match": '"node-etag-1"', "Accept-Encoding": "gzip" });
    cond(p, { "If-Modified-Since": "Wed, 01 Jan 2020 00:00:00 GMT" });
    cond(p, { "If-Modified-Since": "Thu, 01 Jan 2099 00:00:00 GMT" });
    cond(p, { "If-Modified-Since": "Tue, 01 Jan 2019 00:00:00 GMT" });
    cond(p, { "If-Modified-Since": "garbage" });
    cond(p, { "If-None-Match": '"nope"', "If-Modified-Since": "Thu, 01 Jan 2099 00:00:00 GMT" });
    cond(p, { "If-None-Match": '"strong-1"', "If-Modified-Since": "Tue, 01 Jan 2019 00:00:00 GMT" });
    cond(p, { "If-Match": '"strong-1"' });
    cond(p, { "If-Unmodified-Since": "Tue, 01 Jan 2019 00:00:00 GMT" });
  }
  cond("/cond-plain.html", { "If-None-Match": '"anything"' });
  cond("/cond-plain.html", { "If-Modified-Since": "Thu, 01 Jan 2099 00:00:00 GMT" });
  cond("/p/status/404", { "If-None-Match": '"x"' });
  cond("/p/status/404", { "If-Modified-Since": "Thu, 01 Jan 2099 00:00:00 GMT" });
  cond("/redirect-301", { "If-None-Match": '"x"' });
  add("conditional", { host: BLOG, path: "/p/strong-etag", method: "HEAD", headers: { "If-None-Match": '"strong-1"' } });

  // --- Range
  const range = (path, headers) => add("range", { host: BLOG, path, headers });
  for (const p of ["/p/strong-etag", "/range.html", "/photo-range.jpg", "/p/ranged.bin", "/large", "/p/last-modified", "/p/status/404"]) {
    range(p, { Range: "bytes=0-99" });
    range(p, { Range: "bytes=100-" });
    range(p, { Range: "bytes=-50" });
    range(p, { Range: "bytes=0-0" });
    range(p, { Range: "bytes=0-9,20-29" });
    range(p, { Range: "bytes=0-9, 5-15" });
    range(p, { Range: "bytes=99999999-" });
    range(p, { Range: "bytes=abc" });
    range(p, { Range: "items=0-5" });
    range(p, { Range: "bytes=0-99", "Accept-Encoding": "br" });
    range(p, { Range: "bytes=0-99", "If-Range": '"strong-1"' });
    range(p, { Range: "bytes=0-99", "If-Range": '"other"' });
    range(p, { Range: "bytes=0-99", "If-Range": "Wed, 01 Jan 2020 00:00:00 GMT" });
    range(p, { Range: "bytes=0-99", "If-Range": "Thu, 01 Jan 2099 00:00:00 GMT" });
  }
  add("range", { host: BLOG, path: "/range.html", method: "HEAD", headers: { Range: "bytes=0-9" } });
  add("range", { host: SITE, path: "/range-site.html", tls: true, h2: true, headers: { Range: "bytes=0-9" } });

  // --- big bodies (proxy_buffers is 2 MB)
  add("large", { host: BLOG, path: "/p/large-html", headers: { "Accept-Encoding": "br" } });
  add("large", { host: BLOG, path: "/p/large-html", headers: { "Accept-Encoding": "gzip" } });
  add("large", { host: BLOG, path: "/large-chunked", headers: { "Accept-Encoding": "gzip" } });
  add("large", { host: SITE, path: "/large", tls: true, h2: true });

  // --- site over TLS, HTTP/1.1 and HTTP/2
  for (const p of ["/", "/how", "/how/format/markdown", "/templates", "/templates/search?query=a", "/questions", "/questions/replies", "/questions/tags", "/questions/search?query=cats", "/questions/feed.rss", "/news", "/about", "/contact", "/sitemap.xml", "/robots.txt", "/images/logo.png", "/css/app.css", "/js/app.js", "/favicon.ico", "/nothing-here"]) {
    add("site", { host: SITE, path: p, tls: true });
    add("site", { host: SITE, path: p, tls: true, h2: true });
    add("site", { host: SITE, path: p, tls: true, h2: true, headers: { "Accept-Encoding": "br" } });
  }

  // --- the site's uncached routes (must be untouched), every method
  const SITE_ROUTES = [
    "/health", "/redis-health", "/cdn/fonts/x.woff2", "/sites", "/sites/log-in", "/sites/sign-up", "/sites/account/password", "/sites/account", "/sites/example", "/sites/example/templates", "/sites/example/import",
    "/sites/example/client/dropbox/authenticate?code=1", "/dashboard", "/dashboard/x", "/clients/dropbox/webhook?challenge=abc", "/clients/dropbox/webhook", "/clients/google-drive/webhook/abc", "/clients/git/end/example/info/refs?service=git-upload-pack",
    "/clients/git/end/example/git-upload-pack", "/clients/icloud/upload", "/stripe-webhook", "/paypal-webhook", "/questions/123", "/questions/ask", "/news/sign-up", "/news/cancel", "/questions/12/edit", "/questions/12/new", "/sites/EXAMPLE/status-not", "/Sites/log-in",
  ];
  for (const p of SITE_ROUTES) {
    for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
      if (method !== "GET" && method !== "HEAD" && method !== "POST" && !/webhook|clients|sites\/example$/.test(p)) continue;
      const body = method === "POST" || method === "PUT" || method === "PATCH" ? JSON.stringify({ hello: "world", n: 1 }) : undefined;
      add("site-uncached", { host: SITE, path: p, method, tls: true, body, headers: body ? { "Content-Type": "application/json" } : {} });
    }
  }
  // webhook-like POSTs with signature headers and a bigger body
  add("webhook", { host: SITE, path: "/clients/dropbox/webhook", method: "POST", tls: true, body: JSON.stringify({ list_folder: { accounts: ["dbid:1"] }, delta: { users: [1] } }), headers: { "Content-Type": "application/json", "X-Dropbox-Signature": "abc123" } });
  add("webhook", { host: SITE, path: "/clients/google-drive/webhook/blog_1", method: "POST", tls: true, body: "", headers: { "X-Goog-Channel-ID": "c", "X-Goog-Resource-State": "change", "X-Goog-Resource-ID": "r" } });
  add("webhook", { host: SITE, path: "/clients/icloud/upload", method: "PUT", tls: true, body: "x".repeat(300000), headers: { "Content-Type": "application/octet-stream", Authorization: "secret" } });
  add("webhook", { host: SITE, path: "/clients/git/end/example/git-receive-pack", method: "POST", tls: true, body: "0000".repeat(100000), headers: { "Content-Type": "application/x-git-receive-pack-request" } });
  add("webhook", { host: SITE, path: "/stripe-webhook", method: "POST", tls: true, h2: true, body: JSON.stringify({ type: "invoice.paid" }), headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=abc" } });
  add("webhook", { host: SITE, path: "/paypal-webhook", method: "POST", tls: true, body: JSON.stringify({ event_type: "x" }), headers: { "Content-Type": "application/json" } });
  add("webhook", { host: SITE, path: "/sites/log-in", method: "POST", tls: true, body: "email=a%40b.c&password=" + "p".repeat(5000), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  add("webhook", { host: SITE, path: "/sites/example/import", method: "POST", tls: true, h2: true, body: "z".repeat(100000), headers: { "Content-Type": "application/zip" } });

  // --- other methods on cached locations: refused by the proxy
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "PROPFIND"]) {
    const body = method === "POST" || method === "PUT" || method === "PATCH" ? "a=1&b=2" : undefined;
    add("methods", { host: BLOG, path: "/", method, body, headers: body ? { "Content-Type": "application/x-www-form-urlencoded" } : {} });
    add("methods", { host: BLOG, path: "/page-for-methods", method, body });
    add("methods", { host: CUSTOM, path: "/page-for-methods", method, body });
    add("methods", { host: SITE, path: "/", method, tls: true, body });
  }
  add("methods", { host: BLOG, path: "/search?q=x", method: "POST", body: "q=x", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  add("methods", { host: BLOG, path: "/page-for-methods" });
  add("methods", { host: BLOG, path: "/random", method: "POST", body: "x" });

  // --- the blog's uncached routes
  add("blog-uncached", { host: BLOG, path: "/random" });
  add("blog-uncached", { host: BLOG, path: "/random?json=1" });
  add("blog-uncached", { host: BLOG, path: "/random", headers: { "If-None-Match": '"x"', Range: "bytes=0-5" } });
  add("blog-uncached", { host: BLOG, path: "/health" });
  add("blog-uncached", { host: BLOG, path: "/error-upstream-offline.html" });
  add("blog-uncached", { host: BLOG, path: "/files/signal.pdf" });
  add("blog-uncached", { host: BLOG, path: "/_assets/Field Notes From Shipping Real Code With Claude.wav".replace(/ /g, "%20") });
  for (const p of ["/.env", "/wp-admin/x", "/x.php", "/.git/config", "/admin/x", "/package.json", "/config.json", "/swagger.json", "/.well-known/acme-challenge/token123"]) {
    add("blog-uncached", { host: BLOG, path: p });
    add("blog-uncached", { host: CUSTOM, path: p });
  }
  // the uncached routes with conditional/range headers: passed to Node as they come
  add("blog-uncached", { host: BLOG, path: "/draft/stream-not/x" });

  // --- custom domains (the default server), HTTP and HTTPS
  for (const p of ["/", "/post", "/style.css", "/feed.rss", "/search?q=a", "/random"]) {
    add("custom", { host: CUSTOM, path: p });
  }
  add("custom", { host: CUSTOM, path: "/", tls: true });
  add("custom", { host: CUSTOM, path: "/tls-page", tls: true });
  add("custom", { host: CUSTOM, path: "/tls-page", tls: true, h2: true });
  add("custom", { host: CUSTOM, path: "/tls-page", headers: { "Accept-Encoding": "br" } });
  add("custom", { host: CUSTOM, path: "/same-path-other-scheme" });
  add("custom", { host: CUSTOM, path: "/same-path-other-scheme", tls: true });
  add("custom", { host: "www.custom.example", path: "/" });

  // --- preview and cdn hosts (not cached)
  for (const p of ["/", "/style.css", "/photo.jpg", "/page?x=1", "/robots.txt"]) {
    add("preview", { host: PREVIEW, path: p });
    add("preview", { host: PREVIEW, path: p, tls: true });
  }
  add("preview", { host: PREVIEW, path: "/p/vary", headers: { "If-None-Match": '"a"', Range: "bytes=0-3" } });
  add("preview", { host: PREVIEW, path: "/preview-post", method: "POST", body: "x=1" });
  for (const p of ["/", "/fonts/agbalumo/400.woff2", "/folder/v-1234/blog_abc/photo.jpg", "/folder/v-1234/blog_abc/doc.pdf", "/blog_abc/_assets/x.jpg", "/documentation/v-1/css.css", "/health", "/cdn-test.txt", "/p/ranged.bin"]) {
    add("cdn", { host: CDN, path: p });
    add("cdn", { host: CDN, path: p, tls: true });
    add("cdn", { host: CDN, path: p, headers: { Range: "bytes=0-9", "If-None-Match": '"x"', "Accept-Encoding": "br" } });
  }
  add("cdn", { host: CDN, path: "/p/status/404" });
  add("cdn", { host: CDN, path: "/p/ranged.bin", method: "HEAD" });

  // --- the first request for an entry, with a validator or a Range: each on its own path
  let miss = 0;
  for (const headers of [
    { "If-None-Match": '"strong-1"' },
    { "If-None-Match": 'W/"strong-1"' },
    { "If-None-Match": '"other"' },
    { "If-Modified-Since": "Wed, 01 Jan 2020 00:00:00 GMT" },
    { "If-Modified-Since": "Thu, 01 Jan 2099 00:00:00 GMT" },
    { "If-None-Match": '"strong-1"', "If-Modified-Since": "Tue, 01 Jan 2019 00:00:00 GMT" },
    { Range: "bytes=0-99" },
    { Range: "bytes=-50" },
    { Range: "bytes=0-9,20-29" },
    { Range: "bytes=0-99", "If-Range": '"strong-1"' },
    { Range: "bytes=99999999-" },
    { "Accept-Encoding": "br", Range: "bytes=0-99" },
    { "Accept-Encoding": "gzip", "If-None-Match": '"strong-1"' },
  ]) {
    for (const p of ["/p/strong-etag", "/p/ranged.bin", "/p/last-modified", "/miss-page.html"]) {
      add("first-request", { host: BLOG, path: `${p}?first=${++miss}`, headers });
    }
  }
  for (const method of ["HEAD"]) {
    for (const p of ["/p/strong-etag", "/first-head.html", "/p/status/404"]) add("first-request", { host: BLOG, path: `${p}?first=${++miss}`, method });
  }

  // --- streams: not buffered, not cached
  add("sse", { host: SITE, path: "/sites/example/status", tls: true, sse: true });
  add("sse", { host: SITE, path: "/sites/example/status", tls: true, h2: true, sse: true });
  add("sse", { host: BLOG, path: "/draft/stream/post.txt", sse: true });
  add("sse", { host: CUSTOM, path: "/draft/stream/post.txt", sse: true });
  add("sse", { host: PREVIEW, path: "/__blot/preview/reload", sse: true });
  // a stream on a cached location: nginx never cached one (X-Accel-Buffering: no)
  add("stream-cached", { host: BLOG, path: "/p/sse", sse: true });
  add("stream-cached", { host: BLOG, path: "/p/sse", sse: true, headers: { "Accept-Encoding": "br" } });

  return list;
}

// ---- comparing ----------------------------------------------------------

function header(r, name) {
  return r.raw.filter(([k]) => k === name).map(([, v]) => v);
}

const reqHeader = (spec, name) => {
  const k = Object.keys(spec.headers || {}).find((h) => h.toLowerCase() === name);
  return k === undefined ? undefined : spec.headers[k];
};

function decode(r) {
  const enc = (header(r, "content-encoding")[0] || "").toLowerCase();
  try {
    if (enc === "br") return zlib.brotliDecompressSync(r.body);
    if (enc === "gzip") return zlib.gunzipSync(r.body);
    if (enc === "deflate") return zlib.inflateSync(r.body);
  } catch (e) {
    return Buffer.from("(undecodable " + enc + ": " + e.message + ")");
  }
  return r.body;
}

// The NORMALISATIONS: differences that carry no meaning and are never
// reported. Everything else is compared, and what differs must be explained
// by a rule in INTENDED below.
//
//  - Date: changes every second.
//  - Blot-Upstream: which of the four Node ports answered (only whether the
//    header is there is compared).
//  - Content-Length and Transfer-Encoding when status and decoded body are
//    equal: nginx sends a body of known length with Content-Length and one it
//    is still producing (compressed on the fly) chunked. The body is compared
//    in full, so a short or long body still shows. Not applied to HEAD,
//    which has no body to compare.
//  - Blot-* headers repeated with the same value, which nginx's own answers
//    (416, 412) carry twice, on either side.
//  - the multipart/byteranges boundary, which counts up per worker.
//  - ETag and Last-Modified of the offline error page: its file's mtime, and
//    the two images are built at different times.
const OFFLINE_STATUSES = new Set([429, 500, 502, 504]);

function boundaryless(buffer) {
  return Buffer.from(buffer.toString("latin1").replace(/\b0{10,}\d+\b/g, "BOUNDARY"), "latin1");
}

// Compare two responses to one request. Returns [{ kind, name, a, b }]: kind
// is "status", "body" or "header"; a is the baseline's value, b the working tree's.
function diff(spec, ra, rb) {
  const out = [];
  if (ra.status !== rb.status) out.push({ kind: "status", name: "status", a: ra.status, b: rb.status });
  const da = boundaryless(decode(ra));
  const db = boundaryless(decode(rb));
  if (!da.equals(db)) {
    let i = 0;
    while (i < da.length && i < db.length && da[i] === db[i]) i++;
    const show = (b) => `${b.length} bytes: ${JSON.stringify(b.subarray(Math.max(0, i - 20), i + 60).toString("latin1"))}`;
    out.push({ kind: "body", name: "body", a: show(da), b: show(db) });
  }
  const sameBody = da.equals(db) && ra.status === rb.status && spec.method !== "HEAD";
  const offline = OFFLINE_STATUSES.has(ra.status) || spec.path === "/error-upstream-offline.html";
  const names = new Set([...ra.raw, ...rb.raw].map(([k]) => k));
  for (const name of [...names].sort()) {
    if (name === "date") continue;
    if (sameBody && (name === "content-length" || name === "transfer-encoding")) continue;
    if (offline && (name === "etag" || name === "last-modified")) continue;
    let a = header(ra, name);
    let b = header(rb, name);
    if (name === "content-type") {
      a = a.map((v) => v.replace(/boundary=0+\d+/, "boundary=BOUNDARY"));
      b = b.map((v) => v.replace(/boundary=0+\d+/, "boundary=BOUNDARY"));
    }
    if (name.startsWith("blot-")) {
      // nginx's own answers (416, 412) carry an add_header value twice, on
      // either side: compare the set of values
      a = [...new Set(a)];
      b = [...new Set(b)];
    }
    if (name === "blot-upstream") {
      if (a.length !== b.length) out.push({ kind: "header", name, a: a.join(" | ") || "(absent)", b: b.join(" | ") || "(absent)" });
      continue;
    }
    if (a.join("\n") !== b.join("\n")) out.push({ kind: "header", name, a: a.join(" | ") || "(absent)", b: b.join(" | ") || "(absent)" });
  }
  return out;
}

// ---- INTENDED differences -----------------------------------------------
//
// Every difference between the baseline and the working tree that is accepted, and
// why. A rule either explains a whole comparison (whole: true; match gets the
// context) or single differences (match gets the context and the difference).
// ctx = { spec, pass, ra, rb } (ra: the baseline's response, rb: this
// tree's). A difference no rule explains fails the run. `class` is
// "intended" (the design) or "harmless" (not designed, but nothing a client
// can notice or depend on); a bug does not belong here.

// One entry per intended difference, each with a reason:
//
//   {
//     id: "short-name",
//     class: "intended",            // or "harmless"
//     whole: true,                  // optional: explains a whole comparison
//     reason: "what differs and why this PR means it",
//     match: (c, d) => ...,         // c = ctx, d = the difference (not for whole)
//   },
//
// On master this is empty: the working tree is compared with itself as it was
// in origin/master, and must show 0 differences. A proxy PR that changes what
// a client sees lists each change here, so the review is of the list.
const INTENDED = [{
  id: "disable-http3",
  class: "intended",
  reason: "Clear cached HTTP/3 routes while QUIC is disabled pending OpenResty security fixes.",
  match: (c, d) => d.kind === "header" && d.name === "alt-svc" &&
    header(c.ra, "alt-svc").length > 0 &&
    header(c.ra, "alt-svc").length === header(c.rb, "alt-svc").length &&
    header(c.ra, "alt-svc").every((v) => v === 'h3=":443"; ma=86400') &&
    header(c.rb, "alt-svc").every((v) => v === "clear"),
}];

// ---- the run ------------------------------------------------------------

const results = []; // every comparison
const hardFailures = [];

function label(spec) {
  return spec.id;
}

// settleMs is the wait after each GET: a miss is published to the cache after
// its response is sent, so the next request has to wait for that. Passes that
// only serve hits (nothing is published) pass 0.
async function runPass(name, specs, { settleMs = 40, only, skipSSE } = {}) {
  let count = 0;
  for (const spec of specs) {
    if (only && !only(spec)) continue;
    if (skipSSE && spec.sse) continue;
    if (FILTER && !FILTER.test(spec.group)) continue;
    let ra;
    let rb;
    let ea;
    let eb;
    [ra, rb] = await Promise.all([
      send(M, spec).catch((e) => ((ea = e), null)),
      send(B, spec).catch((e) => ((eb = e), null)),
    ]);
    count++;
    if (!ra || !rb) {
      // both failing the same way is parity (a connection closed by 444)
      const same = !ra && !rb && String(ea && ea.message) === String(eb && eb.message);
      results.push({ pass: name, spec, errors: same ? null : [String(ea && ea.message), String(eb && eb.message)], diffs: [], ra, rb });
      continue;
    }
    const diffs = diff(spec, ra, rb);
    results.push({ pass: name, spec, diffs, ra, rb });
    if (!spec.sse && (spec.method || "GET") === "GET") await sleep(settleMs);
  }
  console.log(`  pass ${name}: ${count} requests`);
}

// Classify each difference: intended (by rule) or not
function classify() {
  const intended = {};
  const unexpected = [];
  let identical = 0;
  let total = 0;
  for (const r of results) {
    total++;
    if (r.errors) {
      unexpected.push({ r, d: { kind: "error", name: "request", a: r.errors[0], b: r.errors[1] } });
      continue;
    }
    if (!r.diffs.length) {
      identical++;
      continue;
    }
    const ctx = { spec: r.spec, pass: r.pass, ra: r.ra, rb: r.rb };
    const whole = INTENDED.find((x) => x.whole && x.match(ctx));
    if (whole) {
      intended[whole.id] = (intended[whole.id] || 0) + 1;
      if (VERBOSE) console.log(`  (${whole.class}: ${whole.id}) [${r.pass}] ${label(r.spec)}  ${r.ra.status} -> ${r.rb.status}`);
      continue;
    }
    for (const d of r.diffs) {
      const rule = INTENDED.find((x) => !x.whole && x.match(ctx, d));
      if (rule) {
        intended[rule.id] = (intended[rule.id] || 0) + 1;
        if (VERBOSE) console.log(`  (${rule.class}: ${rule.id}) [${r.pass}] ${label(r.spec)} ${d.kind} ${d.name}: ${d.a}  ->  ${d.b}`);
      } else {
        unexpected.push({ r, d });
        (r.bad = r.bad || []).push(d);
      }
    }
  }
  return { intended, unexpected, identical, total };
}

async function main() {
  cleanup();
  buildImages();
  const specs = corpus();
  console.log(`corpus: ${specs.length} requests`);

  try {
    await Promise.all([startProxy(M), startProxy(B)]);
    await Promise.all([waitStub(M), waitStub(B)]);

    console.log("passes");
    await runPass("1-miss", specs);
    // the first hit of an entry queues its brotli copy
    await runPass("2-hit", specs, { skipSSE: true, settleMs: 0 });
    await sleep(6000);
    await runPass("3-hit-precompressed", specs, { skipSSE: true, settleMs: 0 });

    for (const c of [M, B]) {
      const hosts = [...CACHED_HOSTS, "www.custom.example", "parity.localhost"];
      const p = purge(c, hosts);
      if (p.code !== 200) throw new Error(c.name + " purge failed: " + p.text);
    }
    await sleep(500);
    await runPass("4-refill", specs, { skipSSE: true });

    await coalescing();

    // Node's request counts so far: a difference is a request one proxy made
    // that the other did not (a HEAD that fills the cache, a retry, ...)
    const countsM = stubCounts(M);
    const countsB = stubCounts(B);

    // Node stopped: cached pages are served from the cache, the rest get the offline page
    docker("stop", "-t", "1", M.name + "-stub", B.name + "-stub");
    const downSpecs = specs;
    const fresh = specs
      .filter((s) => (s.method || "GET") === "GET" && !s.raw && !s.sse && s.group !== "sse")
      .filter((s, i) => i % 3 === 0)
      .map((s) => ({ ...s, id: "fresh " + s.id, path: s.path.includes("?") ? s.path + "&fresh=1" : s.path + "?fresh=1" }));
    await runPass("5-node-down-cached", downSpecs, { settleMs: 0 });
    await runPass("5-node-down-uncached", fresh);
    docker("start", M.name + "-stub", B.name + "-stub");
    await Promise.all([waitStub(M), waitStub(B)]);
    await sleep(1000);
    await runPass("6-node-back", fresh);
    await runPass("7-node-back-hit", fresh, { settleMs: 0 });

    // counts
    const countDiffs = [];
    for (const p of new Set([...Object.keys(countsM), ...Object.keys(countsB)])) {
      if ((countsM[p] || 0) !== (countsB[p] || 0)) countDiffs.push({ path: p, a: countsM[p] || 0, b: countsB[p] || 0 });
    }

    report(countDiffs);
  } finally {
    if (process.env.PARITY_KEEP !== "1") cleanup();
  }
}

// Ten simultaneous requests for one uncached page: both proxies should ask
// Node once and give everybody the same page (proxy_cache_lock / the fill lock)
const coalesceFailures = [];
async function coalescing() {
  const path = "/p/slow?coalesce=1";
  const before = [M, B].map((c) => stubCounts(c)["/p/slow"] || 0);
  const out = await Promise.all([M, B].map((c) => Promise.all(Array.from({ length: 10 }, () => send(c, { host: BLOG, path })))));
  const after = [M, B].map((c) => stubCounts(c)["/p/slow"] || 0);
  const asked = [after[0] - before[0], after[1] - before[1]];
  console.log(`  coalescing: 10 simultaneous requests -> Node asked ${asked[0]}x (base), ${asked[1]}x (tree)`);
  if (asked[0] !== asked[1]) coalesceFailures.push(`Node was asked ${asked[0]}x by the baseline and ${asked[1]}x by the tree`);
  for (const [i, label] of ["base", "tree"].entries()) {
    const bad = out[i].filter((r) => r.status !== 200 || !r.body.equals(out[i][0].body));
    if (bad.length) coalesceFailures.push(`${label}: ${bad.length} of 10 simultaneous requests differed from the first`);
  }
  if (!out[0][0].body.equals(out[1][0].body)) coalesceFailures.push("the two proxies answered with different bodies");
}

function report(countDiffs) {
  const { intended, unexpected, identical, total } = classify();
  if (DUMP) {
    fs.writeFileSync(DUMP, JSON.stringify(results.map((r) => ({
      pass: r.pass, id: r.spec.id, group: r.spec.group, errors: r.errors,
      diffs: r.diffs, bad: r.bad,
      base: r.ra && { status: r.ra.status, raw: r.ra.raw, len: r.ra.body.length },
      tree: r.rb && { status: r.rb.status, raw: r.rb.raw, len: r.rb.body.length },
    }))));
  }

  console.log("");
  console.log(`${total} comparisons: ${identical} identical, ${Object.values(intended).reduce((a, b) => a + b, 0)} intended differences, ${unexpected.length} unexpected`);
  for (const [id, n] of Object.entries(intended)) {
    const rule = INTENDED.find((x) => x.id === id);
    console.log(`  intended x${n}  ${id}: ${rule.reason}`);
  }

  // group the unexpected ones by what differs, so a systematic difference is one entry
  const groups = new Map();
  for (const { r, d } of unexpected) {
    const key = `${d.kind}:${d.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ r, d });
  }
  for (const [key, items] of groups) {
    console.log(`\nUNEXPECTED ${key}  (${items.length})`);
    for (const { r, d } of items.slice(0, VERBOSE ? 1000 : 8)) {
      console.log(`  [${r.pass}] ${label(r.spec)}`);
      console.log(`      base: ${d.a}`);
      console.log(`      tree: ${d.b}`);
    }
    if (items.length > 8 && !VERBOSE) console.log(`  ... ${items.length - 8} more (PARITY_VERBOSE=1 lists all)`);
  }

  const unexplained = countDiffs.filter((c) => !COUNT_OK(c));
  const explained = countDiffs.filter(COUNT_OK);
  if (explained.length) {
    console.log(`\nNode was asked a different number of times for ${explained.length} paths INTENDED explains: ${explained.map((c) => c.path).join(" ")}`);
  }
  if (unexplained.length) {
    console.log(`\nUNEXPECTED Node request counts, ${unexplained.length} paths (through the miss, hit, purge, refill passes):`);
    for (const c of unexplained.slice(0, 40)) console.log(`  ${c.path}  base ${c.a}  tree ${c.b}`);
  }

  // streams really stream, on both
  const sseFail = [];
  for (const r of results.filter((x) => x.spec.sse && x.pass === "1-miss" && x.ra && x.rb)) {
    for (const [label, resp] of [["base", r.ra], ["tree", r.rb]]) {
      // the first event is written at once; a buffering proxy would hold it for the 1.5 s the stream lasts
      if (resp.status === 200 && !(resp.firstByteMs < 700)) sseFail.push(`${label} ${r.spec.id}: first byte after ${resp.firstByteMs} ms`);
    }
  }
  if (sseFail.length) {
    console.log("\nSTREAMS BUFFERED");
    sseFail.forEach((l) => console.log("  " + l));
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  if (coalesceFailures.length) {
    console.log("\nSIMULTANEOUS REQUESTS");
    coalesceFailures.forEach((l) => console.log("  " + l));
  }
  const failed = unexpected.length + coalesceFailures.length + sseFail.length + countDiffs.filter((c) => !COUNT_OK(c)).length;
  console.log(`\n${failed ? "FAILED" : "OK"}: ${failed} unexpected differences, ${seconds} s`);
  if (failed) process.exitCode = 1;
}

// Node request counts that may differ, by path: a PR whose change makes Node
// be asked a different number of times for some paths lists them here
// (empty on master)
let COUNT_EXPLAINED = new Set();
const COUNT_OK = (c) => COUNT_EXPLAINED.has(c.path);

main().catch((e) => {
  console.error(e);
  if (process.env.PARITY_KEEP !== "1") cleanup();
  process.exit(1);
});
