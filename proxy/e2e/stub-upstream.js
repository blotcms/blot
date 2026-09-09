// A stand-in for the Blot app: listens on every port the generated proxy
// config expects an upstream on (8088-8091) and echoes what it received so
// the proxy workflow can assert on routing / caching / hardening without a
// real app. Plain node, no dependencies.
const http = require("http");

const PORTS = (process.env.STUB_PORTS || "8088,8089,8090,8091")
  .split(",")
  .map((p) => parseInt(p.trim(), 10));

const handler = (req, res) => {
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/slow") {
    setTimeout(() => res.end("slow"), 2000);
    return;
  }
  if (url.pathname === "/boom") {
    res.writeHead(500);
    res.end("boom");
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
  http.createServer(handler).listen(port, "127.0.0.1", () => {
    console.log("stub upstream listening on 127.0.0.1:" + port);
  });
}
