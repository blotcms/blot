// The upstream for the legacy -> disk transition e2e (transition.sh): stands
// in for the Blot app on 8088-8090 with answers the checker can verify (see
// transition-lib.js). Replaces proxy/e2e/stub-upstream.js in that job.
//
//   GET  /health                    200
//   POST /__gen?host=H              bump H's generation (what a content change
//                                   does), answers the new one; GET reads it
//   GET  /sites/<x>/status          server-sent events, 30 of them 200 ms
//                                   apart, then `event: done`
//   POST anything                   200 {len, sha256} of the body it received
//   GET  /random                    200 {random}, different every time
//   GET  /slow/<n>                  the page for that path after n ms
//   GET  /large/<n>                 a 2.5 MB file
//   GET  anything else              a page
//
// A page or large file carries X-Gen (the host's generation when it was
// built), X-Sum (sha256 of the body it sent) and an ETag naming the generation.
const http = require("http");
const crypto = require("crypto");
const lib = require("./transition-lib");

const PORTS = (process.env.STUB_PORTS || "8088,8089,8090,8091").split(",").map((p) => parseInt(p, 10));
const BIND = process.env.STUB_BIND || "127.0.0.1";

const gens = new Map();
const genOf = (host) => gens.get(host) || 1;
let randoms = 0;

function sendBody(req, res, host, path) {
  const gen = genOf(host);
  const body = lib.bodyFor(host, path, gen);
  res.writeHead(200, {
    "Content-Type": lib.isLarge(path) ? "application/octet-stream" : "text/html; charset=utf-8",
    "Content-Length": body.length,
    "X-Gen": String(gen),
    "X-Sum": lib.sha256(body),
    ETag: lib.etagFor(gen, body),
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const host = (req.headers.host || "").toLowerCase();
  const path = url.pathname;

  if (path === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok");
  }
  if (path === "/__gen") {
    const h = url.searchParams.get("host");
    if (req.method === "POST") gens.set(h, genOf(h) + 1);
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end(String(genOf(h)));
  }
  if (req.method === "POST" || req.method === "PUT") {
    const hash = crypto.createHash("sha256");
    let len = 0;
    req.on("data", (d) => {
      hash.update(d);
      len += d.length;
    });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ host, path, len, sha256: hash.digest("hex") }));
    });
    return;
  }
  if (/^\/sites\/[^/]+\/status$/.test(path)) {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    let sent = 0;
    const timer = setInterval(() => {
      if (sent < lib.SSE_EVENTS) {
        res.write(`data: ${++sent}\n\n`);
      } else {
        clearInterval(timer);
        res.end("event: done\ndata: done\n\n");
      }
    }, 200);
    res.on("close", () => clearInterval(timer));
    return;
  }
  if (path === "/random") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ host, path, random: `${process.pid}-${++randoms}-${Math.random()}` }));
  }
  const slow = /^\/slow\/(\d+)/.exec(path);
  if (slow) return setTimeout(() => sendBody(req, res, host, path), Math.min(parseInt(slow[1], 10), 10000));
  sendBody(req, res, host, path);
}

for (const port of PORTS) {
  // Node's default 5 s keep-alive timeout would close idle connections under
  // the proxy's upstream pool, which a real Node container does not do
  const server = http.createServer(handler);
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.listen(port, BIND, () => console.log(`transition stub listening on ${BIND}:${port}`));
}
