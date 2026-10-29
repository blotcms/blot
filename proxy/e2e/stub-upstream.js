// A stand-in for the Blot app: listens on every port the generated proxy
// config expects an upstream on (8088-8091) and echoes what it received so
// the proxy workflow can assert on routing / caching / hardening without a
// real app. Plain node, no dependencies.
const http = require("http");

const PORTS = (process.env.STUB_PORTS || "8088,8089,8090,8091")
  .split(",")
  .map((p) => parseInt(p.trim(), 10));

// 127.0.0.1 by default (every existing caller reaches this over the same
// network namespace or host loopback). proxy/deploy/e2e sets this to
// 0.0.0.0, as production Node containers (published with docker -p) are.
const BIND = process.env.STUB_BIND || "127.0.0.1";

// Requests seen per path, for proxy/e2e/request-matrix.js and
// diskcache-checks.js to tell whether the proxy asked Node again. Read with
// /__count?path=/some/path.
const counts = {};

// A deterministic ~3 MB body (not compressible as a type, see /large)
const LARGE = Buffer.alloc(3 * 1024 * 1024, "blot-large-body-");


// ---- parity-checks.js helpers ------------------------------------------
const PARITY = process.env.STUB_PARITY === "1";
const crypto = require("crypto");

const isSSE = (p) =>
  p.startsWith("/draft/stream/") || /^\/sites\/[^/]+\/status$/.test(p) || p === "/__blot/preview/reload" || p === "/p/sse";

const TYPES = {
  css: "text/css; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  rss: "application/rss+xml; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  jpg: "image/jpeg",
  woff2: "font/woff2",
  pdf: "application/pdf",
  mp4: "video/mp4",
};

// A pseudo-random but repeatable buffer of n bytes seeded by a string
function noise(seed, n) {
  const out = Buffer.alloc(n);
  let block = crypto.createHash("sha256").update(seed).digest();
  for (let i = 0; i < n; i += 32) {
    block.copy(out, i, 0, Math.min(32, n - i));
    block = crypto.createHash("sha256").update(block).digest();
  }
  return out;
}

// Everything the proxy passed on, except what legitimately varies per request
function echo(req, bodyBuf) {
  const headers = { ...req.headers };
  for (const h of ["x-real-ip", "x-forwarded-for", "x-request-id"]) {
    if (headers[h] !== undefined) headers[h] = "(present)";
  }
  return {
    method: req.method,
    url: req.url,
    headers,
    bodyLength: bodyBuf.length,
    bodySha256: bodyBuf.length ? crypto.createHash("sha256").update(bodyBuf).digest("hex") : null,
  };
}

function sse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
  });
  res.write(": open\n\n");
  let n = 0;
  const timer = setInterval(() => {
    res.write("data: " + ++n + "\n\n");
    if (n === 6) {
      clearInterval(timer);
      res.end();
    }
  }, 250);
  res.on("close", () => clearInterval(timer));
}

// Returns true when it answered
function parityRoute(req, res, url) {
  const p = url.pathname;

  if (isSSE(p)) {
    sse(req, res);
    return true;
  }

  const page = (extra = {}, status = 200, body) => {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...extra });
    res.end(body === undefined ? "<html><body>" + p + " " + "a repeatable filler sentence. ".repeat(40) + "</body></html>" : body);
    return true;
  };

  let m;
  if ((m = p.match(/^\/p\/status\/(\d+)$/))) {
    const code = parseInt(m[1], 10);
    const extra = {};
    if ([301, 302, 307, 308].includes(code)) extra.Location = "/p/target";
    if (code === 503) Object.assign(extra, { "Retry-After": "60", "Cache-Control": "no-store" });
    if (code === 304 || code === 204) {
      res.writeHead(code, extra);
      res.end();
      return true;
    }
    return page(extra, code, "status " + code + " " + "x".repeat(300));
  }
  if (p === "/p/slow") {
    setTimeout(() => page(), 1500);
    return true;
  }
  if (p === "/p/set-cookie") return page({ "Set-Cookie": ["a=1; Path=/; HttpOnly", "__Host-b=2; Path=/; Secure; SameSite=Strict"] });
  if (p === "/p/cache-control") {
    return page({ "Cache-Control": "private, no-store, max-age=0", Expires: "Thu, 01 Jan 1970 00:00:00 GMT", Pragma: "no-cache" });
  }
  if (p === "/p/cache-control-long") return page({ "Cache-Control": "public, max-age=31536000, immutable", Expires: "Fri, 01 Jan 2100 00:00:00 GMT" });
  if (p === "/p/vary") return page({ Vary: "Cookie, Accept-Language" });
  if (p === "/p/dup") return page({ Link: ["</a.css>; rel=preload; as=style", "</b.js>; rel=preload; as=script"], "X-Dup": ["one", "two"] });
  if (p === "/p/last-modified") return page({ "Last-Modified": "Wed, 01 Jan 2020 00:00:00 GMT", ETag: '"lm-1"' });
  if (p === "/p/weak-etag") return page({ ETag: 'W/"weak-1"' });
  if (p === "/p/strong-etag") return page({ ETag: '"strong-1"' });
  if (p === "/p/long-header") return page({ "X-Long": "v".repeat(6000) });
  if (p === "/p/content-disposition") return page({ "Content-Disposition": 'attachment; filename="a b.html"' });
  if (p === "/p/empty") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end();
    return true;
  }
  if (p === "/p/no-content-type") {
    res.writeHead(200);
    res.end("no content type " + "z".repeat(400));
    return true;
  }
  if (p === "/p/chunked") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    for (let i = 0; i < 3; i++) res.write("<p>chunk " + i + " " + "c".repeat(500) + "</p>\n");
    res.end("</body>");
    return true;
  }
  if (p === "/p/large-html") {
    const body = noise("large-html", 3 * 1024 * 1024).toString("base64").replace(/(.{76})/g, "$1\n");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
    return true;
  }
  if (p === "/p/ranged.bin") {
    // honours Range itself, as Express's static middleware does
    const all = noise("ranged", 10000);
    const r = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (r) {
      const start = r[1] === "" ? all.length - parseInt(r[2], 10) : parseInt(r[1], 10);
      const end = r[1] === "" || r[2] === "" ? all.length - 1 : Math.min(parseInt(r[2], 10), all.length - 1);
      res.writeHead(206, { "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes", ETag: '"ranged-1"', "Last-Modified": "Wed, 01 Jan 2020 00:00:00 GMT", "Content-Range": `bytes ${start}-${end}/${all.length}`, "Content-Length": end - start + 1 });
      res.end(all.subarray(start, end + 1));
    } else {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Accept-Ranges": "bytes", ETag: '"ranged-1"', "Last-Modified": "Wed, 01 Jan 2020 00:00:00 GMT", "Content-Length": all.length });
      res.end(all);
    }
    return true;
  }

  // Everything else (PARITY, or /p/echo): an echo of the request, typed by
  // extension, so a proxy that changes what it passes to Node shows up in the body
  const chunks = [];
  req.on("data", (d) => chunks.push(d));
  req.on("end", () => {
    const ext = (p.match(/\.([a-z0-9]+)$/) || [])[1];
    const type = TYPES[ext] || "text/html; charset=utf-8";
    const status = parseInt(url.searchParams.get("stub-status") || "200", 10);
    let body;
    if (ext === "jpg" || ext === "woff2" || ext === "pdf" || ext === "mp4") {
      body = noise(req.url, 20000);
    } else {
      body = Buffer.from(JSON.stringify(echo(req, Buffer.concat(chunks)), null, 1) + "\n" + "padding for compression. ".repeat(60));
    }
    res.writeHead(status, { "Content-Type": type, "Content-Length": body.length });
    res.end(body);
  });
  return true;
}

// Routes that look like the Blot app's, for request-matrix.js
let cookieSeq = 0;
function matrixRoute(req, res, url) {
  const p = url.pathname;
  // with a Content-Length, as Express sends for a rendered page
  const page = (headers) => {
    const body = "<html><body>" + p + " " + "a repeatable filler sentence. ".repeat(40) + "</body></html>";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body), ...headers });
    res.end(body);
    return true;
  };

  // anything that is not a GET or HEAD (webhooks, form posts) is echoed:
  // method, headers Node received, size and hash of the body
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.from(JSON.stringify(echo(req, Buffer.concat(chunks))));
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": body.length });
      res.end(body);
    });
    return true;
  }

  // site pages that set the csrf cookie, one value per request
  if (/^\/questions\/[^/]+$/.test(p) && !/^\/questions\/\d+$/.test(p)) {
    const headers = { "Set-Cookie": "__Host-csrf=token" + ++cookieSeq + "; Path=/; Secure; HttpOnly; SameSite=Strict" };
    if (p === "/questions/search") headers["Cache-Control"] = "private";
    return page(headers);
  }
  // pages Node marks as not for sharing
  if (p.startsWith("/draft/view/") || p.startsWith("/verify/")) return page({ "Cache-Control": "no-cache" });
  if (isSSE(p)) {
    sse(req, res);
    return true;
  }
  if (p.startsWith("/clients/") || p === "/stripe-webhook" || p === "/dashboard" || p === "/sites" || p.startsWith("/sites/")) {
    return page({ "Cache-Control": "no-store" });
  }
  if (p === "/tiny") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": 11 });
    res.end("<p>tiny</p>");
    return true;
  }
  // the kinds of page a blog has (the generic answer below is JSON)
  if (/^\/(post|page|tagged|archive|search)(\/|$)/.test(p)) return page({});
  // files by extension: text types compress, binaries do not
  const ext = (p.match(/\.([a-z0-9]+)$/) || [])[1];
  if (TYPES[ext]) {
    const binary = ["jpg", "woff2", "pdf", "mp4"].includes(ext);
    const body = binary ? noise(p, 20000) : Buffer.from("/* " + p + " */\n" + "a repeatable filler sentence. ".repeat(40));
    res.writeHead(200, { "Content-Type": TYPES[ext], "Content-Length": body.length });
    res.end(body);
    return true;
  }
  if (p === "/random") {
    res.writeHead(302, { Location: "/some-post", "Cache-Control": "no-cache" });
    res.end();
    return true;
  }
  return false;
}

const handler = (req, res) => {
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/__count") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(String(counts[url.searchParams.get("path")] || 0));
    return;
  }
  if (url.pathname === "/__counts") {
    // every path seen and how often (parity-checks.js)
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(counts));
    return;
  }
  counts[url.pathname] = (counts[url.pathname] || 0) + 1;

  // --- routes for proxy/e2e/request-matrix.js and diskcache-checks.js ---
  if (url.pathname === "/etag-page") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ETag: '"node-etag-1"' });
    res.end("<html><body>" + "an etagged page ".repeat(60) + "</body></html>");
    return;
  }
  if (url.pathname === "/redirect-301" || url.pathname === "/redirect-302") {
    // No body and no Content-Type, as Blot's redirects are
    res.writeHead(url.pathname === "/redirect-301" ? 301 : 302, { Location: "/redirect-target" });
    res.end();
    return;
  }
  if (url.pathname.startsWith("/large")) {
    // /large: Content-Length set. /large-chunked: no Content-Length.
    const headers = { "Content-Type": "application/octet-stream" };
    if (!url.pathname.startsWith("/large-chunked")) headers["Content-Length"] = LARGE.length;
    res.writeHead(200, headers);
    res.end(LARGE);
    return;
  }
  if (url.pathname.startsWith("/slow-stream")) {
    // 2 MB with Content-Length, one 100 KB chunk every 200 ms (~4 s)
    const chunk = Buffer.alloc(100 * 1024, "s");
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": chunk.length * 20 });
    let sent = 0;
    const timer = setInterval(() => {
      res.write(chunk);
      if (++sent === 20) {
        clearInterval(timer);
        res.end();
      }
    }, 200);
    res.on("close", () => clearInterval(timer));
    return;
  }
  if (url.pathname.startsWith("/echo-range")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ range: req.headers.range || null, pad: "0123456789".repeat(40) }));
    return;
  }

  if (url.pathname === "/slow") {
    setTimeout(() => res.end("slow"), 2000);
    return;
  }
  if (url.pathname === "/unavailable") {
    // What Node answers when it cannot reach Redis (helper/redisUnavailable)
    res.writeHead(503, { "Retry-After": "60", "Cache-Control": "no-store" });
    res.end("temporarily unavailable");
    return;
  }
  if (url.pathname === "/boom") {
    res.writeHead(500);
    res.end("boom");
    return;
  }
  if (url.pathname.startsWith("/notfound")) {
    // A plain Node 404 (unlike the 444/403 paths blocked by nginx itself
    // before reaching an upstream) - proxy_intercept_errors only covers
    // 500/502/504/429, so this passes straight through.
    res.writeHead(404);
    res.end("not found");
    return;
  }
  if (url.pathname.endsWith(".png")) {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
    return;
  }

  // Blot-like routes (not in STUB_PARITY mode, which echoes everything)
  if (!PARITY && matrixRoute(req, res, url)) return;

  // --- routes for proxy/e2e/parity-checks.js ---
  // /p/* are always on. STUB_PARITY=1 also makes every other path answer with
  // a deterministic body (no clock, no port), so two proxies can be compared.
  if (url.pathname.startsWith("/p/") || PARITY) {
    if (parityRoute(req, res, url)) return;
  }

  // Long, compressible body so gzip and caching are observable.
  const body = JSON.stringify({
    host: req.headers.host,
    served_by: res.socket.localPort,
    path: url.pathname,
    now: Date.now(),
    filler: "blot ".repeat(512),
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(body);
};

for (const port of PORTS) {
  http.createServer(handler).listen(port, BIND, () => {
    console.log("stub upstream listening on " + BIND + ":" + port);
  });
}
