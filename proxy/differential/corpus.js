// The request corpus run against both configs by capture.js. Each entry is
// self-contained (scheme/host/path/method); capture.js records the same
// CAPTURED_HEADERS (lib.js) for each one and diff.js compares the two runs.
//
// `sanity` is an optional independent assertion (checked against BOTH
// captures individually, not against each other) - it exists so a mistake in
// this corpus (e.g. a typo'd path that stops matching a location block)
// shows up as a loud failure instead of both sides quietly agreeing on the
// wrong thing. It is not a substitute for the cross-config diff.
//
// Hosts are all under blot.im because both configs generate that as `host`
// here: the bare-metal generator (config/openresty/build-config.js) always
// uses "blot.im" (config/openresty/locals.js's baremetal() does not read
// BLOT_HOST), so proxy/differential/run.sh builds the container side with
// BLOT_HOST=blot.im too, to keep the two configs' virtual hosts identical.
const BLOCKED_PATHS = [
  // A sample across blot-blogs.conf's rule families - not exhaustive (that
  // file has ~80 location blocks), just enough to catch a rule that behaves
  // differently between the two configs.
  "/.env",
  "/.env.production",
  "/.git/config",
  "/.aws/credentials",
  "/id_rsa",
  "/wp-admin/",
  "/wp-content/plugins/x/wp-json.php", // wp- anywhere in the path
  "/actuator/health",
  "/graphql",
  "/metrics",
  "/vendor/composer/autoload.php", // /vendor/ directory rule -> 403
  "/index.php", // *.php -> 403
  "/docker-compose.yml",
  "/config.json",
];

const corpus = [
  // site host (blot-site.conf), https only + the :80 -> :443 redirect
  { name: "site / over https", scheme: "https", host: "blot.im", path: "/", sanity: { status: 200 } },
  { name: "site / over http redirects to https", scheme: "http", host: "blot.im", path: "/", sanity: { status: 301, locationStartsWith: "https://blot.im" } },
  { name: "site /health", scheme: "https", host: "blot.im", path: "/health", sanity: { status: 200 } },

  // blog subdomain (blot-blogs.conf, wildcard vhost)
  { name: "blog / over http", scheme: "http", host: "someblog.blot.im", path: "/", sanity: { status: 200 } },
  { name: "blog / over https", scheme: "https", host: "someblog.blot.im", path: "/", sanity: { status: 200 } },
  { name: "blog /health", scheme: "http", host: "someblog.blot.im", path: "/health", sanity: { status: 200 } },
  { name: "blog /random bypasses cache", scheme: "http", host: "someblog.blot.im", path: "/random", sanity: { status: 200 } },
  { name: "blog / with HEAD", scheme: "http", host: "someblog.blot.im", path: "/", method: "HEAD", sanity: { status: 200 } },
  // reverse-proxy-cache.conf's `limit_except GET HEAD { deny all; }` on the
  // cached `location /` - a write method there is refused outright, not
  // forwarded to Node.
  { name: "blog / with POST is refused (limit_except)", scheme: "http", host: "someblog.blot.im", path: "/", method: "POST", sanity: { status: 403 } },
  // reverse-proxy-cache.conf's proxy_ignore_headers includes Set-Cookie, so a
  // request carrying a cookie is still cached/served like any other - there
  // is no `proxy_cache_bypass`/`$cookie_*` cache-bypass logic in this config
  // (checked config/openresty/conf/*.conf) for either generator to diverge on.
  { name: "blog / with a cookie (no cache bypass)", scheme: "http", host: "someblog.blot.im", path: "/", headers: { Cookie: "session=abc123" }, sanity: { status: 200 } },

  // custom domain (blot-blogs.conf, default_server)
  { name: "custom domain / over http", scheme: "http", host: "a-custom-domain.example", path: "/", sanity: { status: 200 } },
  { name: "custom domain / over https", scheme: "https", host: "a-custom-domain.example", path: "/", sanity: { status: 200 } },

  // cdn. host. run.sh mounts a fixture static tree into both containers at
  // the same paths both generators emit by default (/var/www/blot/data/static,
  // /var/www/blot/app/blog/static - see proxy/differential/
  // build-baremetal-config.sh's BLOT_DIRECTORY), the same mount
  // blotcms/blot#1975 adds in production for #1941's "Serve cdn. files from
  // disk" item, so this exercises the on-disk `try_files` path (and its
  // Cache-Control/CORS headers) on both sides, not only the fallback.
  { name: "cdn. root redirects to blot.im", scheme: "http", host: "cdn.blot.im", path: "/", sanity: { status: 301, locationStartsWith: "https://blot.im" } },
  // servedFromDisk asserts this is genuinely served from the mounted file,
  // not the @cdn_node fallback below (which is also a 200 - status alone
  // doesn't distinguish them, which is how a file the OpenResty worker
  // couldn't even read - see run.sh's fixture permissions comment - passed
  // this case for a while without being caught).
  { name: "cdn. file served from disk", scheme: "http", host: "cdn.blot.im", path: "/hello.txt", sanity: { status: 200, servedFromDisk: true } },
  // A path with no mounted file still falls through to @cdn_node - a
  // pre-existing gap (blotcms/blot#1941's cdn. checklist item), present
  // identically on both sides here since neither add_header in `location /`
  // applies to the named @cdn_node fallback.
  { name: "cdn. missing file falls through to node", scheme: "http", host: "cdn.blot.im", path: "/does-not-exist-on-disk.png", sanity: { status: 200 } },
  // global-only.txt exists ONLY in the "global" static dir (run.sh), not the
  // "blog" one that server.conf's cdn. location sets as `root`. try_files
  // resolves every non-final argument relative to that `root`, even one
  // that already looks like an absolute path - so
  // {{global_static_files_dir}}$uri does not check
  // "$global_static_files_dir$uri", it checks
  // "$blog_static_files_dir$global_static_files_dir$uri", which never
  // exists. So this file is never actually found on disk today: it falls
  // through to @cdn_node like the missing-file case above, on both configs
  // identically (not a difference between them - a pre-existing config bug,
  // being fixed in sibling PR blotcms/blot#1975). No `servedFromDisk`
  // assertion for now; add one once #1975 lands and this starts being
  // served from disk. Keep the status assertion regardless - both configs
  // still have to agree.
  { name: "cdn. file only in global static dir (not yet found - blotcms/blot#1975)", scheme: "http", host: "cdn.blot.im", path: "/global-only.txt", sanity: { status: 200 } },

  // webhooks. host (SSE relay to the green/master upstream) - only a :443
  // server is defined.
  { name: "webhooks. over https", scheme: "https", host: "webhooks.blot.im", path: "/", sanity: { status: 200 } },

  ...BLOCKED_PATHS.map((path) => ({
    name: `blocked: ${path}`,
    scheme: "http",
    host: "someblog.blot.im",
    path,
    // Every blocked path here returns either 444 (connection closed, "000"
    // in this harness - see lib.js) or 403; never 200.
    sanity: { statusNot: 200 },
  })),

  // upstream error passthrough (both configs proxy_pass to the same stub).
  // MUST stay last: /boom always gets a 500 from whichever upstream serves
  // it, which trips blot_blogs_node's `max_fails` on that upstream (its
  // primary). nginx counts fails per WORKER, with no shared zone across
  // them, so which worker picks up the NEXT request to that upstream group
  // nondeterministically decides whether it still sees the primary disabled
  // and falls to `backup` instead - observed in blotcms/blot#1977 (job
  // 107622786236) as the cache-sequence case's Blot-Upstream flipping
  // between the two configs. capture.js also runs the Blot-Cache MISS/HIT
  // sequence before this whole corpus, for the same reason.
  { name: "upstream 503 passes through", scheme: "http", host: "someblog.blot.im", path: "/unavailable", sanity: { status: 503 } },
  { name: "upstream 500 (offline page body, status preserved)", scheme: "http", host: "someblog.blot.im", path: "/boom", sanity: { status: 500 } },
];

// Blot-Cache MISS -> HIT: two sequential requests to the same cache key.
// Captured separately from `corpus` because it needs two correlated
// requests, not one. capture.js runs this BEFORE `corpus`, so it isn't
// affected by /boom's upstream `max_fails` trip - see the comment next to
// /boom above.
const cacheSequence = {
  name: "Blot-Cache MISS then HIT",
  scheme: "http",
  host: "someblog.blot.im",
  path: "/cache-me/differential",
};

module.exports = { corpus, cacheSequence };
