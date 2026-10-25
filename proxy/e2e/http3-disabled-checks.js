// GitHub integration checks: QUIC is unavailable while HTTP/1.1 and HTTP/2
// still serve every public vhost. Run against the already-started proxy.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const https = require("node:https");
const http2 = require("node:http2");

const container = process.env.PROXY_CONTAINER || "proxy";
const origin = process.env.PROXY_HTTPS || "https://127.0.0.1:8443";
const hosts = process.argv.slice(2);
if (!hosts.length) hosts.push("localhost", "blog.localhost", "preview-blog.localhost", "cdn.localhost", "webhooks.localhost", "someblog.example");
const agent = "Mozilla/5.0 (proxy protocol checks)";
const read = (...paths) => execFileSync("docker", ["exec", container, "cat", ...paths], { encoding: "utf8" });

function http1(host) {
  return new Promise((resolve, reject) => {
    const req = https.get(`${origin}/health`, {
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

function http2Request(host) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(origin, { rejectUnauthorized: false });
    client.on("error", reject);
    client.setTimeout(5000, () => client.destroy(new Error("HTTP/2 timeout")));
    const req = client.request({ ":path": "/health", ":authority": host, "user-agent": agent });
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
  assert(!/^\s*listen\b[^;]*\bquic\b/m.test(config), "rendered config must not enable a QUIC listener");
  assert(!/Alt-Svc[^;]*h3=/i.test(config), "rendered config must not advertise HTTP/3");
  // Inspect the live network namespace too: removing advertisements alone
  // does not prevent cached clients or attackers from reaching QUIC.
  const udp = read("/proc/net/udp", "/proc/net/udp6");
  for (const line of udp.trim().split("\n")) {
    const local = line.trim().split(/\s+/)[1] || "";
    assert(!/:01BB$/i.test(local), "proxy must not bind UDP port 443");
  }
  let cleared = false;
  for (const host of hosts) {
    for (const [fetch, protocol] of [[http1, "1.1"], [http2Request, "h2"]]) {
      const res = await fetch(host);
      assert.equal(res.status, 200, `${host}: /health`);
      assert.equal(res.protocol, protocol, `${host}: negotiated protocol`);
      assert(res.alt === undefined || res.alt === "clear", `${host}: unexpected Alt-Svc ${res.alt}`);
      cleared ||= res.alt === "clear";
      console.log(`ok: ${host} ${protocol}, Alt-Svc=${res.alt || "(absent)"}`);
    }
  }
  assert(cleared, "public responses must clear cached Alt-Svc routes");
  console.log("ok: no QUIC configuration or UDP listener");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
