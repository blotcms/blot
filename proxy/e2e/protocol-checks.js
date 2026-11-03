// GitHub integration checks: the rendered config listens for QUIC, the live
// container binds UDP 443, and HTTP/1.1 and HTTP/2 serve every public vhost
// and advertise HTTP/3 on it, on proxied responses too (cdn. excepted). Run
// against the already-started proxy; the HTTP/3 requests themselves are made
// by h3-check.py.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const https = require("node:https");
const http2 = require("node:http2");

const container = process.env.PROXY_CONTAINER || "proxy";
const origin = process.env.PROXY_HTTPS || "https://127.0.0.1:8443";
const hosts = process.argv.slice(2);
if (!hosts.length) hosts.push("localhost", "blog.localhost", "preview-blog.localhost", "cdn.localhost", "webhooks.localhost", "someblog.example");
const agent = "Mozilla/5.0 (proxy protocol checks)";
const ADVERTISED = 'h3=":443"; ma=86400';
const read = (...paths) => execFileSync("docker", ["exec", container, "cat", ...paths], { encoding: "utf8" });

function http1(host, path) {
  return new Promise((resolve, reject) => {
    const req = https.get(`${origin}${path}`, {
      rejectUnauthorized: false,
      headers: { Host: host, "User-Agent": agent },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, alt: res.headers["alt-svc"], protocol: res.httpVersion }));
      res.on("error", reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error("HTTP/1.1 timeout")));
    req.on("error", reject);
  });
}

function http2Request(host, path) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(origin, { rejectUnauthorized: false });
    client.on("error", reject);
    client.setTimeout(5000, () => client.destroy(new Error("HTTP/2 timeout")));
    const req = client.request({ ":path": path, ":authority": host, "user-agent": agent });
    let headers;
    req.on("response", (value) => { headers = value; });
    req.on("data", () => {});
    req.on("end", () => {
      resolve({ status: headers[":status"], alt: headers["alt-svc"], protocol: client.alpnProtocol });
      client.close();
    });
    req.on("error", (err) => { client.destroy(); reject(err); });
    req.end();
  });
}

async function main() {
  const config = read("/usr/local/openresty/nginx/conf/nginx.conf");
  assert(/^\s*listen\b[^;]*\bquic\b/m.test(config), "rendered config must enable a QUIC listener");
  assert(!/Alt-Svc\s+clear/i.test(config), "rendered config must not clear Alt-Svc");
  // The live network namespace too: an advertisement with nothing on UDP 443
  // sends every client on a failed QUIC attempt.
  const udp = read("/proc/net/udp", "/proc/net/udp6");
  const bound = udp.trim().split("\n").some((line) => /:01BB$/i.test(line.trim().split(/\s+/)[1] || ""));
  assert(bound, "proxy must bind UDP port 443");
  // /health is answered by the proxy; the other path goes to the upstream
  // through the proxy locations, which repeat the server's Alt-Svc. cdn. is
  // reached only by Bunny, so it advertises nothing.
  for (const host of hosts) {
    const expected = host.startsWith("cdn.") ? undefined : ADVERTISED;
    for (const path of ["/health", "/protocol-check"]) {
      for (const [fetch, protocol] of [[http1, "1.1"], [http2Request, "h2"]]) {
        const res = await fetch(host, path);
        assert(path !== "/health" || res.status === 200, `${host}${path}: status ${res.status}`);
        assert(res.status < 500, `${host}${path}: status ${res.status}`);
        assert.equal(res.protocol, protocol, `${host}${path}: negotiated protocol`);
        assert.equal(res.alt, expected, `${host}${path} over ${protocol}: Alt-Svc`);
        console.log(`ok: ${host}${path} ${protocol} ${res.status}, Alt-Svc=${res.alt || "(absent)"}`);
      }
    }
  }
  console.log("ok: QUIC listener configured and UDP 443 bound");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
