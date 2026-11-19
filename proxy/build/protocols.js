// Which protocols the public servers speak besides HTTP/1.1. The generated
// config (server.conf, http.conf) and the proxy e2e checks both read this, so
// flipping a value here changes what is served and what CI expects together.
//
// Both are off until OpenResty ships nginx 1.31.9 (#2789): nginx 1.31.8 has an
// HTTP/2 flow-control memory corruption reachable without credentials
// (CVE-2026-123007), and use-after-frees in HTTP/2 and HTTP/3 when a worker
// runs out of connections (CVE-2026-123633, CVE-2026-121810). See the advisory
// table in proxy/SECURITY.md.
module.exports = {
  http2: false,
  http3: false,
};
