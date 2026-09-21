#!/usr/bin/env node
/**
 * Copy the canonical OpenResty config (config/openresty) into proxy/ and apply
 * the handful of container-specific adaptations the image still needs.
 *
 * config/openresty is the source of truth until the containerised proxy
 * replaces it. Do not hand-edit proxy/config or proxy/html — they are
 * regenerated on every `proxy/build/build.sh` / `proxy/build/index.js` run.
 *
 * Each adaptation below is temporary. When proxy/ becomes canon, fold the
 * surviving bits into the copied files and delete this script.
 */

const fs = require("fs-extra");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "../..");
const SRC_CONF = path.join(REPO_ROOT, "config/openresty/conf");
const SRC_HTML = path.join(REPO_ROOT, "config/openresty/html");
const DEST_CONF = path.join(REPO_ROOT, "proxy/config");
const DEST_HTML = path.join(REPO_ROOT, "proxy/html");

// Files the previous hand-fork of proxy/config omitted. Copying them is the
// point of this de-dup: rate-limits, bot UA restrictions, CDN/Cloudflare
// real-ip, the preview/huge proxy variants. Fail if canon drops one so we
// notice rather than silently shipping a thinner config.
const REQUIRED_CANON_FILES = [
  "auto-ssl.conf",
  "blot-blogs.conf",
  "blot-site.conf",
  "cacher.lua",
  "cloudflare-real-ip.conf",
  "http.conf",
  "init.conf",
  "initial.conf",
  "restrict-bot-uas.conf",
  "reverse-proxy-base.conf",
  "reverse-proxy-cache.conf",
  "reverse-proxy-huge.conf",
  "reverse-proxy-limit-default.conf",
  "reverse-proxy-limit-preview.conf",
  "reverse-proxy-preview.conf",
  "reverse-proxy-sse.conf",
  "reverse-proxy.conf",
  "server.conf",
  "static-file.conf",
  "wildcard-ssl.conf",
];

function count(haystack, needle) {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

function replaceExactly(content, find, replacement, label) {
  const n = count(content, find);
  if (n !== 1) {
    throw new Error(
      `sync-config: ${label}: expected exactly 1 occurrence of:\n---\n${find}\n---\nfound ${n}`
    );
  }
  return content.replace(find, () => replacement);
}

function replaceAllCounted(content, find, replacement, expected, label) {
  const n = count(content, find);
  if (n !== expected) {
    throw new Error(
      `sync-config: ${label}: expected ${expected} occurrences of:\n---\n${find}\n---\nfound ${n}`
    );
  }
  return content.split(find).join(replacement);
}

function writeAdapted(file, adapter) {
  const dest = path.join(DEST_CONF, file);
  const original = fs.readFileSync(dest, "utf8");
  const adapted = adapter(original);
  if (adapted === original) {
    throw new Error(`sync-config: ${file}: adapter made no changes`);
  }
  fs.writeFileSync(dest, adapted);
}

function adaptHttpConf(content) {
  // Bare-metal rotates files under OPENRESTY_LOG_DIRECTORY. The container
  // logs to stdout/stderr so `docker logs` works. LOG_TO_STDOUT is set by
  // proxy/build/build.sh (default true).
  return replaceExactly(
    content,
    "error_log {{{log_directory}}}/error.log info;\naccess_log {{{log_directory}}}/access.log access_log_format;\n",
    "{{#log_to_stdout}}\n" +
      "# Container-native logging: `docker logs` shows access + error lines.\n" +
      "error_log /dev/stderr info;\n" +
      "access_log /dev/stdout access_log_format;\n" +
      "{{/log_to_stdout}}\n" +
      "{{^log_to_stdout}}\n" +
      "error_log {{{log_directory}}}/error.log info;\n" +
      "access_log {{{log_directory}}}/access.log access_log_format;\n" +
      "{{/log_to_stdout}}\n",
    "http.conf log_to_stdout"
  );
}

// Values which can change without rebuilding the image become ${NAME}
// placeholders that proxy/render-config.sh fills in from the environment when
// the container starts (see config/openresty/locals.js, runtimeDefaults).
function adaptHttpConfRuntime(content) {
  content = replaceAllCounted(
    content,
    "127.0.0.1:8089",
    "${PROXY_UPSTREAM_GREEN}",
    2,
    "http.conf green upstream"
  );
  content = replaceAllCounted(
    content,
    "127.0.0.1:8088",
    "${PROXY_UPSTREAM_BLUE}",
    3,
    "http.conf blue upstream"
  );
  content = replaceAllCounted(
    content,
    "127.0.0.1:8090",
    "${PROXY_UPSTREAM_YELLOW}",
    1,
    "http.conf yellow upstream"
  );

  // The Bunny edge list is fetched when the container starts (falling back to
  // the list baked in at build time), so it is an include, not inlined.
  return replaceExactly(
    content,
    "    {{#cdn_ips}}\n    {{ip}} 1;\n    {{/cdn_ips}}\n",
    "    include /etc/openresty/cdn-ips.conf;\n",
    "http.conf cdn_ips include"
  );
}

function adaptInitConf(content) {
  // Docker user-defined networks want 127.0.0.11; host-network / prod still
  // use 8.8.8.8. OPENRESTY_RESOLVER is baked by build.sh.
  content = replaceExactly(
    content,
    "resolver 8.8.8.8 ipv6=off;",
    "resolver {{{resolver}}};",
    "init.conf resolver"
  );

  // Two containers on --network host would otherwise fight over :8999 during
  // a blue/green overlap. Known limitation: the kernel can route a hook
  // request to the other instance (different auto_ssl_settings secret) —
  // tracked in TODO.
  content = replaceExactly(
    content,
    "  listen 127.0.0.1:8999;",
    "  listen 127.0.0.1:8999 {{#reuseport}}reuseport{{/reuseport}};",
    "init.conf hook listen reuseport"
  );

  // ca: Let's Encrypt in production, Pebble in CI (ACME_CA / build.sh).
  // dir: matches the volume + chown in proxy/Dockerfile; lua-resty-auto-ssl
  // defaults here anyway, but being explicit keeps dehydrated state on the
  // persistent volume.
  content = replaceExactly(
    content,
    '    auto_ssl = (require "resty.auto-ssl").new()\n',
    '    auto_ssl = (require "resty.auto-ssl").new()\n' +
      "\n" +
      "    -- ACME directory URL. Baked at generate time: Let's Encrypt in\n" +
      "    -- production, a Pebble test server in CI (see ACME_CA / build.sh).\n" +
      '    auto_ssl:set("ca", "{{{acme_ca}}}")\n' +
      "\n" +
      "    -- Root for the dehydrated hook scripts and their working files. The\n" +
      "    -- issued certs themselves live in Redis via the storage adapter below;\n" +
      "    -- this directory is created and chowned in proxy/Dockerfile and lives on\n" +
      "    -- a persistent volume in a real deployment.\n" +
      '    auto_ssl:set("dir", "/etc/resty-auto-ssl")\n',
    "init.conf auto_ssl ca/dir"
  );

  return content;
}

function adaptInitialConf(content) {
  // nginx only forwards env vars named here into workers. lua-resty-auto-ssl
  // shells out to dehydrated -> curl inside a worker; entrypoint.sh sets
  // these when a non-public ACME CA must be trusted (Pebble in CI). Naming
  // an unset variable is a no-op.
  return replaceExactly(
    content,
    "user\t  {{user}} {{user}};  ## Default: nobody\n\nworker_processes auto;\n",
    "user\t  {{user}} {{user}};  ## Default: nobody\n\n" +
      "env CURL_CA_BUNDLE;\n" +
      "env SSL_CERT_FILE;\n\n" +
      "worker_processes auto;\n",
    "initial.conf env passthrough"
  );
}

function adaptServerConf(content) {
  // webhooks. only ever goes to the master (see the comment in server.conf)
  content = replaceExactly(
    content,
    "proxy_pass http://127.0.0.1:8089;",
    "proxy_pass http://${PROXY_UPSTREAM_GREEN};",
    "server.conf webhooks upstream"
  );

  // The pinned openresty/openresty:1.25.3.1-alpine-fat image is not
  // guaranteed to have --with-http_v3_module (docker-openresty added it in
  // 1.25.3.1-1). Bare-metal has HTTP/3; drop it in the container copy so
  // `openresty -t` stays green. Fold back in once the image is rebuilt with
  // v3, or once proxy/ is canon on an image that has it.
  content = replaceAllCounted(
    content,
    "        listen 443 quic;\n        add_header Alt-Svc 'h3=\":443\"; ma=86400' always;\n",
    "",
    5,
    "server.conf strip http3"
  );
  content = replaceExactly(
    content,
    "        listen 443 quic reuseport default_server;\n        add_header Alt-Svc 'h3=\":443\"; ma=86400' always;\n",
    "",
    "server.conf strip http3 default_server"
  );

  // reuseport may appear only once per address:port; putting it on the
  // default server is enough for the shared :80 / :443 ssl sockets. A
  // second container can then bind the same ports during blue/green.
  content = replaceExactly(
    content,
    "        listen 80 default_server;\n        listen 443 ssl default_server;\n",
    "        listen 80 default_server {{#reuseport}}reuseport{{/reuseport}};\n" +
      "        listen 443 ssl default_server {{#reuseport}}reuseport{{/reuseport}};\n",
    "server.conf default_server reuseport"
  );

  // 127.0.0.1:80 is a different socket from 0.0.0.0:80 and would otherwise
  // collide during a host-network overlap.
  content = replaceExactly(
    content,
    "       listen 127.0.0.1:80;\n",
    "       listen 127.0.0.1:80 {{#reuseport}}reuseport{{/reuseport}};\n",
    "server.conf loopback reuseport"
  );

  // Per-container health: a Unix socket in this container's /run, so a
  // reuseport TCP port the *other* container could answer cannot make a
  // not-yet-ready replacement look healthy. Dockerfile HEALTHCHECK and
  // proxy/deploy/blue-green.sh probe this.
  content = replaceExactly(
    content,
    "    # internal server for inspecting and purging the cache\n",
    "    # Container-local readiness probe. The Dockerfile HEALTHCHECK and\n" +
      "    # proxy/deploy/blue-green.sh probe THIS Unix socket, which lives in the\n" +
      "    # container's own /run - never a reuseport TCP port, which the *other*\n" +
      "    # container in a blue/green overlap could answer, letting a not-yet-ready\n" +
      "    # replacement look healthy.\n" +
      "    server {\n" +
      "        listen unix:/run/openresty/health.sock;\n" +
      "        location = /health { return 200; }\n" +
      "        location / { return 404; }\n" +
      "    }\n" +
      "\n" +
      "    # internal server for inspecting and purging the cache\n",
    "server.conf health socket"
  );

  return content;
}

function assertRequiredCanonFiles() {
  const missing = REQUIRED_CANON_FILES.filter(
    (file) => !fs.existsSync(path.join(SRC_CONF, file))
  );
  if (missing.length) {
    throw new Error(
      "sync-config: canonical config/openresty/conf is missing: " +
        missing.join(", ")
    );
  }
}

function sync() {
  assertRequiredCanonFiles();

  fs.emptyDirSync(DEST_CONF);
  fs.copySync(SRC_CONF, DEST_CONF);
  fs.emptyDirSync(DEST_HTML);
  fs.copySync(SRC_HTML, DEST_HTML);

  writeAdapted("http.conf", adaptHttpConf);
  writeAdapted("http.conf", adaptHttpConfRuntime);
  writeAdapted("init.conf", adaptInitConf);
  writeAdapted("initial.conf", adaptInitialConf);
  writeAdapted("server.conf", adaptServerConf);

  console.log(
    "sync-config: copied config/openresty/{conf,html} -> proxy/{config,html} and applied container adaptations"
  );
}

if (require.main === module) {
  sync();
}

module.exports = { sync };
