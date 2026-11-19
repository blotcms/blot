// GitHub integration checks: the public servers speak the protocols
// proxy/build/protocols.js turns on, and no others. With HTTP/3 on, the
// rendered config listens for QUIC, the live container binds UDP 443 and every
// HTTPS response advertises it (cdn. excepted); with it off there is no QUIC
// listener or UDP socket and those responses send Alt-Svc: clear. HTTP/2 is
// checked by ALPN. Run against the already-started proxy; the HTTP/3 requests
// themselves are made by h3-check.py.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const https = require("node:https");
const http2 = require("node:http2");
const protocols = require("../build/protocols");

const container = process.env.PROXY_CONTAINER || "proxy";
const origin = process.env.PROXY_HTTPS || "https://127.0.0.1:8443";
const hosts = process.argv.slice(2);
if (!hosts.length)
  hosts.push(
    "localhost",
    "blog.localhost",
    "preview-blog.localhost",
    "cdn.localhost",
    "webhooks.localhost",
    "someblog.example"
  );
const agent = "Mozilla/5.0 (proxy protocol checks)";
const ADVERTISED = protocols.http3 ? 'h3=":443"; ma=86400' : "clear";
const read = (...paths) =>
  execFileSync("docker", ["exec", container, "cat", ...paths], {
    encoding: "utf8",
  });

function http1(host, path) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `${origin}${path}`,
      {
        rejectUnauthorized: false,
        headers: { Host: host, "User-Agent": agent },
      },
      (res) => {
        res.resume();
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            alt: res.headers["alt-svc"],
            protocol: res.httpVersion,
          })
        );
        res.on("error", reject);
      }
    );
    req.setTimeout(5000, () => req.destroy(new Error("HTTP/1.1 timeout")));
    req.on("error", reject);
  });
}

function http2Request(host, path) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(origin, { rejectUnauthorized: false });
    client.on("error", reject);
    client.setTimeout(5000, () => client.destroy(new Error("HTTP/2 timeout")));
    const req = client.request({
      ":path": path,
      ":authority": host,
      "user-agent": agent,
    });
    let headers;
    req.on("response", (value) => {
      headers = value;
    });
    req.on("data", () => {});
    req.on("end", () => {
      resolve({
        status: headers[":status"],
        alt: headers["alt-svc"],
        protocol: client.alpnProtocol,
      });
      client.close();
    });
    req.on("error", (err) => {
      client.destroy();
      reject(err);
    });
    req.end();
  });
}

// The protocol the server picks when a client offers h2 and http/1.1, asked
// with the image's openssl from inside the container (the CI proxy serves a
// self-signed placeholder, which s_client reports but does not reject)
function alpn(host) {
  const out = execFileSync(
    "docker",
    [
      "exec",
      container,
      "sh",
      "-c",
      'openssl s_client -connect 127.0.0.1:443 -servername "$1" -alpn h2,http/1.1 </dev/null 2>&1',
      "sh",
      host,
    ],
    { encoding: "utf8" }
  );
  const picked = /ALPN protocol: (\S+)/.exec(out);
  if (picked) return picked[1];
  assert(/No ALPN negotiated/.test(out), `${host}: openssl s_client\n${out}`);
  return null;
}

async function main() {
  const config = read("/usr/local/openresty/nginx/conf/nginx.conf");
  const quic = /^\s*listen\b[^;]*\bquic\b/m.test(config);
  assert.equal(quic, protocols.http3, "rendered config: QUIC listener");
  assert.equal(
    /^\s*http2\s+on\s*;/m.test(config),
    protocols.http2,
    "rendered config: http2 on"
  );
  // The live network namespace too: an advertisement with nothing on UDP 443
  // sends every client on a failed QUIC attempt, and a socket left open with
  // HTTP/3 off is still reachable by anyone who tries it.
  const udp = read("/proc/net/udp", "/proc/net/udp6");
  const bound = udp
    .trim()
    .split("\n")
    .some((line) => /:01BB$/i.test(line.trim().split(/\s+/)[1] || ""));
  assert.equal(bound, protocols.http3, "proxy binds UDP port 443");
  for (const host of hosts) {
    const picked = alpn(host);
    assert.equal(
      picked,
      protocols.http2 ? "h2" : "http/1.1",
      `${host}: ALPN when offered h2`
    );
    console.log(`ok: ${host} ALPN picks ${picked}`);
  }
  // /health is answered by the proxy; the other path goes to the upstream
  // through the proxy locations, which have add_header of their own. Exactly
  // one Alt-Svc on both. cdn. is reached only by Bunny, so it advertises
  // nothing.
  for (const host of hosts) {
    const expected = host.startsWith("cdn.") ? undefined : ADVERTISED;
    for (const path of ["/health", "/protocol-check"]) {
      for (const [fetch, protocol] of [
        [http1, "1.1"],
        ...(protocols.http2 ? [[http2Request, "h2"]] : []),
      ]) {
        const res = await fetch(host, path);
        assert(
          path !== "/health" || res.status === 200,
          `${host}${path}: status ${res.status}`
        );
        assert(res.status < 500, `${host}${path}: status ${res.status}`);
        assert.equal(
          res.protocol,
          protocol,
          `${host}${path}: negotiated protocol`
        );
        assert.equal(
          res.alt,
          expected,
          `${host}${path} over ${protocol}: Alt-Svc`
        );
        console.log(
          `ok: ${host}${path} ${protocol} ${res.status}, Alt-Svc=${res.alt || "(absent)"}`
        );
      }
    }
  }
  console.log(
    protocols.http3
      ? "ok: QUIC listener configured and UDP 443 bound"
      : "ok: no QUIC listener and nothing on UDP 443"
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
