// End-to-end checks that drive requests THROUGH the proxy container to the
// Blot app container. No dependencies - plain node. Run by
// .github/workflows/integration.yml after `docker compose up`.
//
//   PROXY_ORIGIN   base URL of the proxy (default https://127.0.0.1)
//   BLOT_HOST      Host header the proxy routes the site on (default localhost)
//   E2E_EMAIL      seeded user's email
//   E2E_PASSWORD   seeded user's password
//
// The proxy terminates TLS with the image's self-signed placeholder cert, so
// certificate verification is disabled here. The Blot dashboard lives under
// /sites (see app/site/index.js).

const https = require("https");
const http = require("http");
const { URL } = require("url");

const PROXY_ORIGIN = process.env.PROXY_ORIGIN || "https://127.0.0.1";
const HOST = process.env.BLOT_HOST || "localhost";
const EMAIL = process.env.E2E_EMAIL || "e2e@example.com";
const PASSWORD = process.env.E2E_PASSWORD || "e2e-password";

let failures = 0;
let passes = 0;

function check(name, cond, detail) {
  if (cond) {
    passes++;
    console.log("  ok  -", name);
  } else {
    failures++;
    console.log("  FAIL -", name, detail ? "->  " + detail : "");
  }
}

function mergeCookies(jar, setCookie) {
  for (const raw of setCookie || []) {
    const [pair] = raw.split(";");
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
}
function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

function once(path, { method = "GET", jar, body, headers = {} } = {}) {
  const url = new URL(path, PROXY_ORIGIN);
  const mod = url.protocol === "https:" ? https : http;
  const opts = {
    method,
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    path: url.pathname + url.search,
    headers: { Host: HOST, ...headers },
    rejectUnauthorized: false,
  };
  if (jar && Object.keys(jar).length) opts.headers.Cookie = cookieHeader(jar);
  let payload;
  if (body) {
    payload = new URLSearchParams(body).toString();
    opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
    opts.headers["Content-Length"] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = mod.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (jar) mergeCookies(jar, res.headers["set-cookie"]);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("request timed out")));
    if (payload) req.write(payload);
    req.end();
  });
}

// Follow up to `max` redirects, rewriting absolute Location URLs back onto the
// proxy origin (+ Host header) and carrying the cookie jar. 301/302 downgrade
// to GET, like a browser.
async function request(path, opts = {}, max = 5) {
  let res = await once(path, opts);
  let hops = 0;
  let nextOpts = opts;
  while (
    res.status >= 300 &&
    res.status < 400 &&
    res.headers.location &&
    hops < max
  ) {
    hops++;
    const loc = new URL(res.headers.location, PROXY_ORIGIN);
    const nextPath = loc.pathname + loc.search;
    nextOpts =
      res.status === 307 || res.status === 308
        ? { ...opts, jar: opts.jar }
        : { jar: opts.jar, headers: opts.headers };
    res = await once(nextPath, nextOpts);
  }
  res.hops = hops;
  return res;
}

(async function main() {
  // 1. The proxy answers its own health check.
  const health = await request("/health");
  check("proxy /health returns 200", health.status === 200, "got " + health.status);

  // 2. The marketing site is reachable through the proxy.
  const home = await request("/");
  check("GET / routes to the app (2xx)", home.status >= 200 && home.status < 300, "got " + home.status);
  check("GET / returns a non-empty body", home.body.length > 0);

  // 3. The sign-in page renders (dashboard lives under /sites). Do this with
  //    the cookie jar so we pick up the __Host-csrf cookie + token.
  const jar = {};
  const loginPage = await request("/sites/log-in", { jar });
  check("GET /sites/log-in returns 200", loginPage.status === 200, "got " + loginPage.status);
  check(
    "sign-in page has email + password fields",
    /name=["']?email/.test(loginPage.body) && /name=["']?password/.test(loginPage.body)
  );
  const csrf = (loginPage.body.match(/name=["']?_csrf["']?\s+value=["']([^"']+)["']/) || [])[1];
  check("sign-in page carries a CSRF token", !!csrf, csrf ? "" : "no _csrf field found");

  // 4. The dashboard requires auth.
  const anonSites = await once("/sites");
  check(
    "GET /sites while logged out redirects to log-in",
    anonSites.status >= 300 && anonSites.status < 400 && /log-in/.test(anonSites.headers.location || ""),
    `status ${anonSites.status} location ${anonSites.headers.location}`
  );

  // 5. Sign in with the seeded user (double-submit CSRF: cookie in the jar,
  //    token in the body).
  const signIn = await request("/sites/log-in", {
    method: "POST",
    jar,
    body: { email: EMAIL, password: PASSWORD, _csrf: csrf },
  });
  check("POST sign-in sets a session cookie", Object.keys(jar).length > 0, JSON.stringify(jar));
  check(
    "after sign-in the dashboard is reachable (200)",
    signIn.status === 200,
    "got " + signIn.status + " after " + signIn.hops + " hop(s)"
  );

  // 6. Session works on a fresh request.
  const authedSites = await request("/sites", { jar });
  check(
    "GET /sites while logged in returns 200",
    authedSites.status === 200,
    "got " + authedSites.status + " location " + authedSites.headers.location
  );

  // 7. Sign out, then the session no longer works (log-out is also a
  //    CSRF-protected mutation).
  const signOut = await once("/sites/account/log-out", {
    method: "POST",
    jar,
    body: { _csrf: csrf },
  });
  check("POST log-out succeeds", signOut.status >= 200 && signOut.status < 400, "got " + signOut.status);
  const afterLogout = await once("/sites", { jar });
  check(
    "GET /sites after log-out redirects to log-in",
    afterLogout.status >= 300 && afterLogout.status < 400 && /log-in/.test(afterLogout.headers.location || ""),
    `status ${afterLogout.status} location ${afterLogout.headers.location}`
  );

  // 8. The proxy's hardening rules apply end to end (blog traffic path).
  const git = await once("/.git/config", { headers: { Host: "e2e-blog.example" } });
  check("GET /.git/config on a blog host is blocked (404)", git.status === 404, "got " + git.status);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error("e2e runner crashed:", err);
  process.exit(1);
});
