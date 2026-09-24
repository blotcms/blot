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
// 0.0.0.0: cutover-from-baremetal.sh's rehearsal runs on the default Docker
// bridge, not --network host, and connects to the upstream via the bridge
// gateway address - unreachable on a loopback-only bind.
const BIND = process.env.STUB_BIND || "127.0.0.1";

const handler = (req, res) => {
  const url = new URL(req.url, "http://x");

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
