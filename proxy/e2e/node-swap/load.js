// Load generator for the node-swap e2e: round-robins three request kinds through
// the proxy's :80 default server, records every failure, exits 1 if any.
//
// Rate: the runner IP is NOT whitelisted (geo $whitelist in proxy/config/http.conf
// only has the mac server IP + CDN ranges, and CI builds with FETCH_CDN_IPS=false),
// so limit_req (general 6r/s/IP, hostlimit 10r/s/host, burst 30) and limit_conn
// (20/IP) apply. 6 workers x one request per ~1.2s = ~5 r/s total, 6 connections.
const http = require("http");
const https = require("https");
const fs = require("fs");

const DURATION = parseInt(process.env.DURATION || "10", 10) * 1000;
const WORKERS = parseInt(process.env.WORKERS || "6", 10);
const PAUSE_MS = parseInt(process.env.PAUSE_MS || "1170", 10);
const HOSTIP = process.env.HOSTIP || "127.0.0.1";
const OUT = process.env.OUT || "load-result.json";

const agent = new http.Agent({ keepAlive: true });
// The site (Host: localhost) redirects plain HTTP to HTTPS; the CI proxy
// serves a self-signed certificate.
const tlsAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false, servername: "localhost" });
let n = 0;

// Routes (proxy/config): blog GET -> blot_blogs_node (server.conf:107, unique path
// so the proxy cache can't answer); POST /clients -> blot_node (blot-site.conf:105);
// GET /dashboard/<n> -> blot_dashboard_node (blot-site.conf:1 default, uncached).
const KINDS = [
  (i) => ({ name: "blog-get", host: "someblog.example", method: "GET", path: `/p/${i}` }),
  (i) => ({ name: "site-post", host: "localhost", tls: true, method: "POST", path: "/clients/dropbox/webhook", body: `{"n":${i}}` }),
  (i) => ({ name: "site-get", host: "localhost", tls: true, method: "GET", path: `/dashboard/${i}` }),
];

const stats = Object.fromEntries(KINDS.map((k) => [k(0).name, { total: 0, status: {}, errors: {} }]));
const failures = [];

function request(r) {
  return new Promise((resolve) => {
    const req = (r.tls ? https : http).request(
      { host: HOSTIP, port: r.tls ? 443 : 80, agent: r.tls ? tlsAgent : agent, method: r.method, path: r.path, timeout: 20000,
        headers: { Host: r.host, ...(r.body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(r.body) } : {}) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let name;
          try { name = JSON.parse(data).name; } catch (e) {}
          resolve({ status: res.statusCode, name });
        });
      }
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
    req.on("error", (e) => resolve({ error: e.code || e.message }));
    req.end(r.body);
  });
}

async function worker(end) {
  while (Date.now() < end) {
    const i = n++;
    const r = KINDS[i % KINDS.length](i);
    const s = stats[r.name];
    const out = await request(r);
    s.total++;
    if (out.error) s.errors[out.error] = (s.errors[out.error] || 0) + 1;
    else s.status[out.status] = (s.status[out.status] || 0) + 1;
    if (out.error || out.status < 200 || out.status > 299) {
      failures.push({ time: new Date().toISOString(), kind: r.name, status: out.status, error: out.error, name: out.name });
    }
    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  }
}

const end = Date.now() + DURATION;
Promise.all(Array.from({ length: WORKERS }, () => worker(end))).then(() => {
  console.log("kind        total  status / errors");
  for (const [k, s] of Object.entries(stats)) {
    console.log(k.padEnd(11), String(s.total).padStart(5), " ", JSON.stringify(s.status), JSON.stringify(s.errors));
  }
  console.log(`failures: ${failures.length}`);
  for (const f of failures) console.log(JSON.stringify(f));
  fs.writeFileSync(OUT, JSON.stringify({ stats, failures }, null, 2));
  agent.destroy();
  tlsAgent.destroy();
  process.exit(failures.length ? 1 : 0);
});
