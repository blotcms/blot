// Shared helpers for proxy/differential's capture.js and diff.js. Plain node,
// no dependencies (matches proxy/e2e/run.js).

const https = require("https");
const http = require("http");

// Response headers worth diffing between the bare-metal and container
// configs (the task's "statuses, redirects, selected response headers,
// ..."). Anything not listed here is generated identically by both (they
// share config/openresty/conf) or isn't interesting to compare - keeping the
// list short keeps the diff output readable.
const CAPTURED_HEADERS = [
  "location",
  "cache-control",
  "access-control-allow-origin",
  "blot-cache",
  "blot-server",
  "blot-upstream",
  "x-content-type-options",
  "strict-transport-security",
  "x-frame-options",
  "content-type",
  "vary",
  "set-cookie",
  "alt-svc",
  "content-encoding",
  "retry-after",
];

// Header values that legitimately vary run-to-run (or would in a real
// deployment) rather than between the two configs, so a value difference
// here is not a behavioural difference. blot-upstream is deliberately NOT
// here: both sides target the same hardcoded 127.0.0.1:8088-8090 upstreams
// (http.conf), so its value should be deterministic and worth comparing
// exactly - the container's ${PROXY_UPSTREAM_*} substitution (sync-config.js)
// rewriting the mapping wrong is exactly the kind of bug this harness exists
// to catch. Where a specific case's upstream genuinely isn't deterministic
// (a failover, not a config difference), allow it explicitly in diff.js's
// ALLOWED_DIFFERENCES instead of loosening this globally. set-cookie is a
// session cookie in a real deployment (e.g. a CSRF/session id) - never
// stable value-for-value, so only whether one was set is meaningful here.
const IGNORE_VALUE_OF = new Set(["set-cookie"]);

function request({ scheme, host, base, path, method = "GET", headers = {} }) {
  const mod = scheme === "https" ? https : http;
  const opts = {
    method,
    hostname: base,
    port: scheme === "https" ? 443 : 80,
    path,
    headers: { Host: host, "User-Agent": "blot-proxy-differential", ...headers },
    rejectUnauthorized: false, // both sides serve a self-signed placeholder cert
    timeout: 10000,
  };

  return new Promise((resolve) => {
    const req = mod.request(opts, (res) => {
      // Drain and discard the body: the stub's body includes a timestamp and
      // the port it was served from, neither of which is meaningful to diff.
      res.on("data", () => {});
      res.on("end", () => {
        const capturedHeaders = {};
        for (const name of CAPTURED_HEADERS) {
          if (res.headers[name] !== undefined) capturedHeaders[name] = res.headers[name];
        }
        resolve({ status: res.statusCode, headers: capturedHeaders });
      });
    });
    req.on("timeout", () => req.destroy());
    // `return 444;` (the blocked-scanner paths) closes the connection with no
    // HTTP response at all - curl reports this as code 000 (see
    // proxy/e2e/checks.sh); do the same here so it's a comparable value
    // instead of a thrown error.
    req.on("error", () => resolve({ status: "000", headers: {} }));
    req.end();
  });
}

module.exports = { request, CAPTURED_HEADERS, IGNORE_VALUE_OF };
