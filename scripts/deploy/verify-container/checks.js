// Each check takes a context and resolves to a short detail string when it
// passes, or throws when it doesn't. See ./index.js for how they are run.
//
// context: { config, redis, expectedRelease, skipRedisWrite }
//   redis - a connected node-redis client (dedicated to this run)

const fs = require("fs/promises");
const path = require("path");
const http = require("http");
const net = require("net");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

// A blog folder on disk is data/blogs/{blogID}. Deleted blogs and blogs that
// never synced mean the two won't match exactly, so this is a loose floor:
// a wrong, stale or empty mount misses most blogs, not a few. The real ratio
// is always in the report - tighten this once we've seen it in prod.
const MIN_BLOGS_WITH_FOLDER = 0.5;

// An absolute floor only: the data disk is meant to fill up with blogs, so
// how full it is belongs in monitoring, not a deploy gate.
const MIN_FREE_BYTES = 2 * 1024 ** 3; // 2GiB

// The status page (https://status.blot.im) checks this same blog. Rendering
// it exercises redis, the blogs mount, the templates and the blog server in
// one request. Preview subdomains are exempt from the HTTPS redirect, so
// plain HTTP to the container works.
//
// The request goes straight to this container's own node process, on
// 127.0.0.1 or, in a unit, its socket (this script runs inside it via
// `docker exec`), never through
// the OpenResty proxy: its cache or another container could otherwise
// answer, and the check would pass for the wrong container.
const CANARY_HANDLE = "david";
const CANARY_TEMPLATE = "wireframe";

// Environment variables the app can't do its job without.
const REQUIRED_ENV = [
  "BLOT_SESSION_SECRET",
  "BLOT_STRIPE_SECRET",
  "BLOT_STRIPE_WEBHOOK_SECRET",
  // the sandbox: production has no other browser or egress proxy
  "BLOT_SANDBOX_SOCKET",
  "BLOT_EGRESS_PROXY_URL",
];

// Where this process serves: 127.0.0.1:<port>, or its socket when it has no
// TCP port (a unit's node-a). A base URL and request() options.
function local({ port, socket }) {
  return port
    ? { base: `http://127.0.0.1:${port}`, options: {} }
    : { base: "http://localhost", options: { socketPath: socket } };
}

function request({ url, host, headers = {}, timeout = 8000, options = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      url,
      { headers: { Host: host, ...headers }, timeout, ...options },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("timeout", () => req.destroy(new Error(`timed out after ${timeout}ms`)));
    req.on("error", reject);
  });
}

async function redisRoundTrip({ redis, skipRedisWrite }) {
  await redis.ping();
  // PING succeeds against a read-only replica; a write doesn't. A host cycle
  // starts units on a replica on purpose (config/host/cycle.sh app).
  if (skipRedisWrite) return "ping succeeded, write skipped (--skip-redis-write)";
  const key = `deploy-verify:${process.pid}:${Date.now()}`;
  await redis.set(key, "ok", { EX: 30 });
  const value = await redis.get(key);
  await redis.del(key);
  if (value !== "ok") throw new Error(`wrote "ok", read back ${JSON.stringify(value)}`);
  return "ping, write and read succeeded";
}

// config/host/scripts/mount-data-volume.sh requires this file on the data
// volume before it will mount it. A container started against an empty
// directory on the root disk (the volume not mounted) won't have it.
const DATA_VOLUME_MARKER = ".blot-data-volume";

async function dataVolumeMarker({ config }) {
  const file = path.join(config.data_directory, DATA_VOLUME_MARKER);
  let volumeID;
  try {
    volumeID = (await fs.readFile(file, "utf8")).trim();
  } catch (err) {
    throw new Error(
      `cannot read ${file}: ${err.message} - data volume not mounted?`
    );
  }
  return volumeID ? `data volume ${volumeID}` : `${file} is present`;
}

async function dataDirectory({ config, redis }) {
  const blogsDir = config.blog_folder_dir;
  let entries;
  try {
    entries = await fs.readdir(blogsDir, { withFileTypes: true });
  } catch (err) {
    throw new Error(`cannot read ${blogsDir}: ${err.message}`);
  }

  const folders = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
  const blogIDs = await redis.sMembers("blogs");

  if (!blogIDs.length) throw new Error("redis has no blogs");
  if (!folders.size) throw new Error(`${blogsDir} has no blog folders`);

  const withFolder = blogIDs.filter((id) => folders.has(id)).length;
  const ratio = withFolder / blogIDs.length;
  const summary = `${withFolder}/${blogIDs.length} blogs in redis have a folder, ${folders.size} folders on disk`;

  if (ratio < MIN_BLOGS_WITH_FOLDER) {
    throw new Error(`${summary} (need ${MIN_BLOGS_WITH_FOLDER * 100}%) - wrong or stale data mount?`);
  }
  return summary;
}

async function writable(directory) {
  const file = path.join(directory, `deploy-verify-${process.pid}`);
  await fs.writeFile(file, "ok");
  await fs.unlink(file);
  return `${directory} is writable`;
}

// The mount is owned by the host; the app runs as uid 1000.
async function dataDirectoryWritable({ config }) {
  return writable(config.data_directory);
}

// The tmp directory is a separate mount (the host's instance store), so
// proving the data volume writable says nothing about it. The host creates it
// (mount-instance-store.sh): not creating it here means a missing or
// root-owned one fails the deploy rather than being papered over.
async function tmpDirectoryWritable({ config }) {
  return writable(config.tmp_directory);
}

// Generated assets live only in the storage bucket, so a container that can't
// reach it (no bucket, wrong region or credentials) must not go live. Asking
// for a key which isn't there proves the bucket, the credentials and
// s3:GetObject together: it answers "not found", where a wrong bucket or
// credentials is an error.
async function storageBucket({ config }) {
  const s3 = require("storage/s3");

  s3.assertConfigured();

  const missing = await s3.head("deploy-verify/does-not-exist");

  if (missing) throw new Error("deploy-verify/does-not-exist exists in the storage bucket");

  return `storage bucket ${config.storage.bucket} is reachable`;
}

async function diskSpace({ config }) {
  const stats = await fs.statfs(config.data_directory);
  const free = stats.bavail * stats.bsize;
  const ratio = free / (stats.blocks * stats.bsize);
  const summary = `${(free / 1024 ** 3).toFixed(1)}GiB free (${(ratio * 100).toFixed(0)}%)`;
  if (free < MIN_FREE_BYTES) {
    throw new Error(`${summary} on the data mount`);
  }
  return summary;
}

async function binary(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 10000 });
    return stdout.split("\n")[0].trim();
  } catch (err) {
    throw new Error(`${command} is not runnable: ${err.message}`);
  }
}

const pandoc = () => binary("pandoc", ["--version"]);
const git = () => binary("git", ["--version"]);

// Decodes a real HEIC (the same photo the img converter's spec uses; app
// tests aren't in the production image, so it's copied here). Advertised
// format support isn't enough: a missing or broken HEVC decoder still lists
// heif as an input.
async function sharpWorks() {
  const sharp = require("sharp");
  const fixture = path.join(__dirname, "fixtures", "car.heic");
  const { width, height } = await sharp(fixture).jpeg().toBuffer().then((buffer) =>
    sharp(buffer).metadata()
  );
  if (!width || !height) throw new Error("decoded HEIC has no dimensions");
  return `sharp decoded a HEIC to a ${width}x${height} JPEG`;
}

// The nsjail sandbox (app/sandbox), only when the host turned it on: the
// deploy must prove the broker, the jail, the seccomp profile and the cgroups
// work in this container before it is live. The same photo as above; the HEIC
// is 4032x3024 whether or not the 270 degree rotation is applied, so the check
// does not depend on which way round the jail reports it.
async function sandboxWorks() {
  if (!process.env.BLOT_SANDBOX_SOCKET) return "skipped, BLOT_SANDBOX_SOCKET is not set";

  const sandbox = require("../../../app/sandbox");
  const fixture = path.join(__dirname, "fixtures", "car.heic");
  const { meta } = await sandbox.run("metadata", {}, { path: fixture });
  const sides = [meta.width, meta.height].sort((a, b) => a - b);
  if (sides.join("x") !== "3024x4032") {
    throw new Error(`the jail read a ${meta.width}x${meta.height} ${meta.format}, expected 4032x3024`);
  }
  return `the jail read a ${meta.width}x${meta.height} ${meta.format}`;
}

// The browser jail, whenever there is a sandbox: Chromium starts in it, and
// the egress filter is really there. The metadata address must be refused: a
// jail that reaches it, or times out on it, is not a jail to go live with.
async function sandboxBrowserWorks() {
  if (!process.env.BLOT_SANDBOX_SOCKET) return "skipped, BLOT_SANDBOX_SOCKET is not set";

  const sandbox = require("../../../app/sandbox");
  const empty = Buffer.alloc(0);

  // Two pages, as a batch: both must come back
  const blank = await sandbox.run(
    "screenshot",
    { pages: [{ url: "about:blank" }, { url: "about:blank", mobile: true }] },
    empty
  );
  const results = (blank.meta && blank.meta.results) || [];
  if (results.length !== 2 || results.some((r) => r.error) || blank.outputs.some((o) => !o.length)) {
    throw new Error(`no screenshots: ${JSON.stringify(blank.meta)}`);
  }

  const metadata = await sandbox.run(
    "screenshot",
    { url: "http://169.254.169.254/latest/meta-data/" },
    empty
  );
  if (!/ERR_(CONNECTION_REFUSED|ADDRESS_UNREACHABLE|NETWORK_ACCESS_DENIED)/.test(metadata.meta.error || "")) {
    throw new Error(`the metadata address was not refused: ${metadata.meta.error || "it answered"}`);
  }
  return `Chromium started and ${metadata.meta.error}`;
}

// The fetch-image and fetch jobs, whenever there is a sandbox: their jail starts
// in its cgroup, and the egress filter refuses the metadata address, by URL and
// pinned as an address. A jail that reaches it, or times out on it, is not one
// to go live with.
async function sandboxFetchWorks() {
  if (!process.env.BLOT_SANDBOX_SOCKET) return "skipped, BLOT_SANDBOX_SOCKET is not set";

  const sandbox = require("../../../app/sandbox");
  const { meta } = await sandbox.run(
    "fetch-image",
    { url: "http://169.254.169.254/latest/meta-data/" },
    Buffer.alloc(0)
  );
  if (!/^(ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EACCES|EPERM)$/.test(meta.code || "")) {
    throw new Error(`the metadata address was not refused: ${meta.error || "it answered"}`);
  }

  const REFUSED = /^(ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EACCES|EPERM)$/;
  const batch = await sandbox.run(
    "fetch",
    {
      requests: [
        { url: "http://169.254.169.254/latest/meta-data/" },
        { url: "http://example.com/", ip: "169.254.169.254" },
      ],
    },
    Buffer.alloc(0)
  );
  const results = (batch.meta && batch.meta.results) || [];
  for (const result of results) {
    if (!REFUSED.test(result.code || "")) {
      throw new Error(`the metadata address was not refused by the fetch job: ${result.error || "it answered"}`);
    }
  }
  if (results.length !== 2) throw new Error("the fetch job did not answer both requests");
  return `the fetch jails started and ${meta.code}`;
}

// The parse-html job, whenever there is a sandbox: the jail can load the HTML
// parser and Markdown converter (they are read from node_modules, which a
// missing or mismatched package would leave out) and does the importer's three
// operations on a small post.
async function sandboxParseHtmlWorks() {
  if (!process.env.BLOT_SANDBOX_SOCKET) return "skipped, BLOT_SANDBOX_SOCKET is not set";

  const sandbox = require("../../../app/sandbox");
  const html = Buffer.from('<p>Hello <strong>world</strong><img src="https://example.com/a.png"></p>');

  const scanned = await sandbox.run("parse-html", { op: "scan", kind: "images" }, html);
  if (scanned.meta.error || scanned.meta.urls.join() !== "https://example.com/a.png") {
    throw new Error(`parse-html did not find the image: ${scanned.meta.error || JSON.stringify(scanned.meta)}`);
  }
  const rewritten = await sandbox.run(
    "parse-html",
    { op: "rewrite", kind: "images", replacements: [["https://example.com/a.png", "_a.png"]] },
    html
  );
  if (rewritten.meta.error || !rewritten.outputs[0].toString().includes('src="_a.png"')) {
    throw new Error(`parse-html did not rewrite the image: ${rewritten.meta.error || "no change"}`);
  }
  const markdown = await sandbox.run("parse-html", { op: "markdown" }, html);
  if (markdown.meta.error || !markdown.outputs[0].toString().startsWith("Hello **world**")) {
    throw new Error(`parse-html did not convert to Markdown: ${markdown.meta.error || markdown.outputs[0]}`);
  }
  return "the jail scanned, rewrote and converted a post";
}

// The proxy jail, whenever there is a sandbox. A forward-proxy request for the
// metadata address must not get through: tinyproxy answers 500 when the filter
// refuses it, which also proves the proxy answers at all.
async function sandboxProxyWorks({ config }) {
  if (!process.env.BLOT_SANDBOX_SOCKET) return "skipped, BLOT_SANDBOX_SOCKET is not set";

  const { hostname, port } = new URL(config.egress.proxy);
  const metadata = "http://169.254.169.254/latest/meta-data/";
  const res = await request({
    url: metadata,
    host: "169.254.169.254",
    options: { hostname, port, path: metadata },
  });
  if (res.status !== 500) throw new Error(`the metadata address answered ${res.status} through the proxy`);
  return `the metadata address was refused through ${config.egress.proxy}`;
}

// The host's firewall for the units (blot-app-firewall.service, from
// config/host/host/setup.sh) refuses uid 1000 the metadata service, so a fetch
// that misses the proxy jail can't reach it. The deploy runs this as uid 1000,
// in the unit's cgroup, which is what the rule matches. Refused at once: a
// connection or a timeout means the rule is not loaded.
async function hostFirewall() {
  if (!process.env.BLOT_UNIT) return "skipped, BLOT_UNIT is not set";
  if (process.getuid() !== 1000) return `skipped, uid ${process.getuid()} is not the units' uid`;

  const refused = ["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EACCES", "EPERM"];
  const code = await new Promise((resolve) => {
    const socket = net.connect({ host: "169.254.169.254", port: 80, timeout: 3000 });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.on("connect", () => done("connected"));
    socket.on("timeout", () => done("timed out"));
    socket.on("error", (err) => done(err.code || err.message));
  });
  if (!refused.includes(code)) {
    throw new Error(`the metadata service was not refused (${code}): is blot-app-firewall.service loaded?`);
  }
  return `the metadata service was refused (${code})`;
}

// With the sandbox on, Node runs under one seccomp filter more than this process,
// which docker exec started outside the supervisor (proxy/unit/supervisor.sh).
async function nodeFilter() {
  if (!process.env.BLOT_SANDBOX_SOCKET) return "skipped, BLOT_SANDBOX_SOCKET is not set";

  const filters = (status) => Number(/^Seccomp_filters:\s*(\d+)/m.exec(status)[1]);
  const own = filters(await fs.readFile("/proc/self/status", "utf8"));

  let checked = 0;
  for (const pid of (await fs.readdir("/proc")).filter((name) => /^\d+$/.test(name))) {
    const command = await fs.readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
    if (command !== "node\0app/index.js\0") continue;
    const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
    if (filters(status) <= own || !/^NoNewPrivs:\s*1/m.test(status)) {
      throw new Error(`node pid ${pid} is not under the filter`);
    }
    checked++;
  }
  if (!checked) throw new Error("did not find node-a");
  return `node-a has more seccomp filters than a docker exec (${own})`;
}

async function requiredEnv() {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`unset: ${missing.join(", ")}`);
  return `${REQUIRED_ENV.length} variables set`;
}

async function releaseID({ expectedRelease }) {
  if (!expectedRelease) throw new Error("no expected release ID was passed");
  if (process.env.BLOT_RELEASE_ID !== expectedRelease) {
    throw new Error(
      `container is ${process.env.BLOT_RELEASE_ID}, deploying ${expectedRelease}`
    );
  }
  return expectedRelease;
}

async function canaryBlog({ config }) {
  const host = `preview-of-${CANARY_TEMPLATE}-on-${CANARY_HANDLE}.${config.host}`;
  const { base, options } = local(config);
  const res = await request({ url: `${base}/`, host, options });
  if (res.status !== 200) throw new Error(`${host} returned ${res.status}`);
  if (!/<html/i.test(res.body) || !/<\/html>/i.test(res.body) || res.body.length < 500) {
    throw new Error(`${host} returned a ${res.body.length} byte body that isn't a complete HTML page`);
  }
  return `${host} rendered (${res.body.length} bytes)`;
}

async function loginPage({ config }) {
  const { base, options } = local(config);
  const res = await request({
    url: `${base}/sites/log-in`,
    host: config.host,
    headers: { "X-Forwarded-Proto": "https" },
    options,
  });
  if (res.status !== 200) throw new Error(`/sites/log-in returned ${res.status}`);
  return "dashboard log-in page rendered";
}

module.exports = [
  { name: "release ID", run: releaseID },
  { name: "redis read/write", run: redisRoundTrip },
  { name: "data volume marker", run: dataVolumeMarker },
  { name: "blog folders match redis", run: dataDirectory },
  { name: "data directory writable", run: dataDirectoryWritable },
  { name: "tmp directory writable", run: tmpDirectoryWritable },
  { name: "storage bucket reachable", run: storageBucket },
  { name: "disk space", run: diskSpace },
  { name: "pandoc", run: pandoc },
  { name: "git", run: git },
  { name: "sharp", run: sharpWorks },
  { name: "sandbox", run: sandboxWorks },
  { name: "sandbox browser", run: sandboxBrowserWorks },
  { name: "sandbox fetch", run: sandboxFetchWorks },
  { name: "sandbox parse-html", run: sandboxParseHtmlWorks },
  { name: "node filter", run: nodeFilter },
  { name: "required environment", run: requiredEnv },
  { name: "sandbox proxy", run: sandboxProxyWorks },
  { name: "host firewall", run: hostFirewall },
  { name: "canary blog render", run: canaryBlog },
  { name: "dashboard log-in render", run: loginPage },
];
