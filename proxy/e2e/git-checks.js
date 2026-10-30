// End-to-end checks for the git client: a real `git` goes through the real
// proxy container to the real production app image, then the published blog is
// fetched over HTTP. No dependencies - plain node, run by
// .github/workflows/app-e2e.yml after proxy/e2e/seed-git.js.
//
// It only uses what a user can see (the remote URL, git's output and exit
// codes, pages over HTTP), so it must keep passing unchanged however the
// server side of the git client is implemented.
//
//   BLOT_HOST        the site host the git remote lives on (default localhost)
//   PROXY_ORIGIN     where the proxy listens, for raw requests (default https://127.0.0.1)
//   E2E_GIT_HANDLE   the seeded git blog's handle
//   E2E_GIT_TOKEN    its owner's git token (throwaway CI user)
//   E2E_GIT_EMAIL    its owner's email
//   E2E_GIT_BLOG_ID  its blog ID (for the rename step)
//   E2E_GIT_BLOG_HOST  its vhost, e.g. e2egit.localhost
//
// The proxy terminates TLS with the image's self-signed placeholder cert, so
// verification is off (-c http.sslVerify=false, rejectUnauthorized: false).

const https = require("https");
const { URL } = require("url");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOST = process.env.BLOT_HOST || "localhost";
const PROXY_ORIGIN = process.env.PROXY_ORIGIN || "https://127.0.0.1";
const HANDLE = process.env.E2E_GIT_HANDLE;
const TOKEN = process.env.E2E_GIT_TOKEN;
const EMAIL = process.env.E2E_GIT_EMAIL || "e2e@example.com";
const BLOG_ID = process.env.E2E_GIT_BLOG_ID;
const BLOG_HOST = process.env.E2E_GIT_BLOG_HOST || HANDLE + "." + HOST;

if (!HANDLE || !TOKEN) {
  console.error("E2E_GIT_HANDLE and E2E_GIT_TOKEN are required");
  process.exit(1);
}

const GIT_TIMEOUT_MS = 120000;
const BLOG_DEADLINE_MS = 90000;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function remoteURL(handle = HANDLE, token = TOKEN) {
  return (
    "https://" +
    encodeURIComponent(EMAIL) +
    ":" +
    encodeURIComponent(token) +
    "@" +
    HOST +
    "/clients/git/end/" +
    handle +
    ".git"
  );
}

const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "blot-git-e2e-"));
let dirCount = 0;
const newDir = (label) => {
  const dir = path.join(workRoot, ++dirCount + "-" + label);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

// Runs the runner's git. Never prompts, never reads a config file, never
// outlives GIT_TIMEOUT_MS (a hang is a failure, not a stuck job).
function git(args, { cwd = workRoot, env = {}, input, timeout = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn("git", ["-c", "http.sslVerify=false", ...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: workRoot,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "E2E",
        GIT_AUTHOR_EMAIL: "e2e@example.com",
        GIT_COMMITTER_NAME: "E2E",
        GIT_COMMITTER_EMAIL: "e2e@example.com",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

const tail = (s, n = 400) => {
  s = String(s || "").trim();
  return s.length > n ? "..." + s.slice(-n) : s;
};
const why = (r) =>
  (r.timedOut ? "TIMED OUT; " : "") + "exit " + r.code + ": " + tail(r.stderr || r.stdout);

// GIT_TRACE_CURL prints each request's headers to stderr; this is how a check
// proves a request really went out chunked or gzipped.
const TRACE = { GIT_TRACE_CURL: "1", GIT_TRACE_CURL_NO_DATA: "1" };

// A raw request to the proxy, with a Host header, like run.js does.
function raw(pathAndQuery, { method = "GET", host = HOST, headers = {}, body } = {}) {
  const url = new URL(pathAndQuery, PROXY_ORIGIN);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers: { "User-Agent": "blot-git-e2e", Host: host, ...headers },
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error("request timed out")));
    req.end(body);
  });
}

const basic = (token) =>
  "Basic " + Buffer.from(EMAIL + ":" + token).toString("base64");

// Polls fn() (which returns {ok, detail}) until ok or the deadline passes.
async function until(fn, timeoutMs = BLOG_DEADLINE_MS, intervalMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let last = { ok: false, detail: "never ran" };
  while (Date.now() < deadline) {
    try {
      last = await fn();
    } catch (err) {
      last = { ok: false, detail: err.message };
    }
    if (last.ok) return last;
    await sleep(intervalMs);
  }
  return last;
}

const snippet = (res) =>
  "status " +
  res.status +
  ", Blot-Cache " +
  res.headers["blot-cache"] +
  ", body: " +
  JSON.stringify(res.body.toString("utf8").replace(/\s+/g, " ").slice(0, 300));

// Waits for the blog's index page to satisfy pred(bodyText). The page comes
// through the proxy's cache and is never cache-busted: the push has to purge
// it (app/helper/flushProxies), and a stale page is the bug being looked for.
async function waitForIndex(pred, host = BLOG_HOST) {
  return until(async () => {
    const res = await raw("/", { host });
    const ok = res.status === 200 && pred(res.body.toString("utf8"));
    return { ok, detail: snippet(res) };
  });
}

// Fills the cache for the page before a push, so that a push which fails to
// purge is seen as a stale HIT.
async function primeIndex(host = BLOG_HOST) {
  await raw("/", { host });
  const res = await raw("/", { host });
  return (res.headers["blot-cache"] || "").toUpperCase();
}

function write(dir, name, content) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const post = (title, body) =>
  ["Title: " + title, "Date: 2021-01-01", "", body].join("\n") + "\n";

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

async function commitAll(dir, message) {
  await git(["add", "-A"], { cwd: dir });
  return git(["commit", "-q", "-m", message], { cwd: dir });
}

async function revParse(dir, ref = "HEAD") {
  return (await git(["rev-parse", ref], { cwd: dir })).stdout.trim();
}

// The server's master, as a client sees it.
async function remoteMaster(url = remoteURL(), env = {}) {
  const r = await git(["ls-remote", url, "refs/heads/master"], { env });
  return r.code === 0 ? r.stdout.split(/\s+/)[0] : "";
}

async function main() {
  // The stack is up, but wait until the proxy answers git requests (the
  // answer to an unauthenticated one is a 401) before the first check.
  const infoRefs = (h = HANDLE, service = "git-upload-pack") =>
    "/clients/git/end/" + h + ".git/info/refs?service=" + service;

  const ready = await until(async () => {
    const res = await raw(infoRefs());
    return { ok: res.status < 500, detail: "status " + res.status };
  }, 60000);
  if (!ready.ok) {
    console.log("  FAIL - git endpoint never became ready through the proxy ->", ready.detail);
    return;
  }

  // 1. Clone and ls-remote.
  const a = newDir("clone-a");
  const cloneA = await git(["clone", remoteURL(), a]);
  check("clone through the proxy succeeds", cloneA.code === 0, why(cloneA));
  if (cloneA.code !== 0) return;

  const seeded = path.join(a, "seeded.txt");
  check(
    "clone has the file the repository was created with",
    fs.existsSync(seeded) && /Seeded git post/.test(fs.readFileSync(seeded, "utf8")),
    "files: " + fs.readdirSync(a).join(",")
  );
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: a })).stdout.trim();
  check("clone is on master", branch === "master", "branch " + branch);

  const ls = await git(["ls-remote", remoteURL()]);
  const headA = await revParse(a);
  check(
    "ls-remote lists HEAD and refs/heads/master at the cloned commit",
    ls.code === 0 &&
      ls.stdout.includes(headA + "\tHEAD") &&
      ls.stdout.includes(headA + "\trefs/heads/master"),
    why(ls) + " want " + headA
  );

  // A second clone, kept to fetch incrementally in step 7.
  const b = newDir("clone-b");
  const cloneB = await git(["clone", remoteURL(), b]);
  check("second clone succeeds", cloneB.code === 0, why(cloneB));

  // 2. Bad credentials fail with a 401, and quickly.
  const noAuth = await raw(infoRefs());
  check(
    "info/refs without credentials is 401 with a Basic challenge",
    noAuth.status === 401 && /basic/i.test(noAuth.headers["www-authenticate"] || ""),
    "status " + noAuth.status + " www-authenticate " + noAuth.headers["www-authenticate"]
  );
  const wrongTok = await raw(infoRefs(), {
    headers: { Authorization: basic("not-the-token") },
  });
  check("info/refs with a wrong token is 401", wrongTok.status === 401, "got " + wrongTok.status);
  const wrongPush = await raw(infoRefs(HANDLE, "git-receive-pack"), {
    headers: { Authorization: basic("not-the-token") },
  });
  check("receive-pack advertisement with a wrong token is 401", wrongPush.status === 401, "got " + wrongPush.status);
  const noAuthPost = await raw("/clients/git/end/" + HANDLE + ".git/git-receive-pack", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-git-receive-pack-request",
      "Content-Length": "8",
    },
    body: "0000PACK",
  });
  check("POST git-receive-pack without credentials is 401", noAuthPost.status === 401, "got " + noAuthPost.status);

  const t0 = Date.now();
  const badClone = await git(["ls-remote", remoteURL(HANDLE, "not-the-token")], { timeout: 30000 });
  check(
    "git with a wrong token fails with an authentication error",
    badClone.code !== 0 && !badClone.timedOut && /401|authentication failed/i.test(badClone.stderr),
    why(badClone)
  );
  check("a rejected git request does not hang", Date.now() - t0 < 20000, Date.now() - t0 + "ms");
  const badPush = await git(["push", remoteURL(HANDLE, "not-the-token"), "HEAD:master"], {
    cwd: a,
    timeout: 30000,
  });
  check(
    "git push with a wrong token fails",
    badPush.code !== 0 && !badPush.timedOut && /401|authentication failed/i.test(badPush.stderr),
    why(badPush)
  );

  // 3. Push a new post and see it on the blog.
  const primed = await primeIndex();
  check("blog index is cached before the push (so a missing purge would show)", primed === "HIT", "Blot-Cache " + primed);

  const title1 = "First pushed post " + crypto.randomBytes(3).toString("hex");
  write(a, "pushed.txt", post(title1, "Pushed with a real git client."));
  await commitAll(a, "add post");
  const push1 = await git(["push", "origin", "HEAD:master"], { cwd: a });
  check("push a new post", push1.code === 0, why(push1));
  check("server master is the pushed commit", (await remoteMaster()) === (await revParse(a)));

  const seen1 = await waitForIndex((t) => t.includes(title1));
  check("pushed post appears on the blog (cache purged)", seen1.ok, seen1.detail);
  for (let i = 0; i < 2 && seen1.ok; i++) {
    const again = await raw("/", { host: BLOG_HOST });
    check(
      "blog keeps showing the pushed post on later hits",
      again.body.toString("utf8").includes(title1),
      snippet(again)
    );
  }

  // 4. Edit it.
  await primeIndex();
  const title2 = "Edited pushed post " + crypto.randomBytes(3).toString("hex");
  write(a, "pushed.txt", post(title2, "Edited with a real git client."));
  await commitAll(a, "edit post");
  const push2 = await git(["push", "origin", "HEAD:master"], { cwd: a });
  check("push an edit", push2.code === 0, why(push2));
  const seen2 = await waitForIndex((t) => t.includes(title2) && !t.includes(title1));
  check("edited post replaces the old title on the blog", seen2.ok, seen2.detail);

  // 5. Delete it.
  await primeIndex();
  fs.unlinkSync(path.join(a, "pushed.txt"));
  await commitAll(a, "delete post");
  const push3 = await git(["push", "origin", "HEAD:master"], { cwd: a });
  check("push a deletion", push3.code === 0, why(push3));
  const seen3 = await waitForIndex((t) => !t.includes(title2) && !t.includes(title1));
  check("deleted post disappears from the blog", seen3.ok, seen3.detail);

  // 6. Chunked pushes. With http.postBuffer below the pack size git streams
  //    the body with Transfer-Encoding: chunked, which the proxy must pass on
  //    (proxy_request_buffering is off for /clients/git/end/).
  const small = crypto.randomBytes(300 * 1024);
  write(a, "files/chunked-small.bin", small);
  await commitAll(a, "add 300k binary");
  const pushSmall = await git(["-c", "http.postBuffer=65536", "push", "origin", "HEAD:master"], {
    cwd: a,
    env: TRACE,
  });
  check("push of a body above http.postBuffer succeeds", pushSmall.code === 0, why(pushSmall));
  check(
    "that push was sent with chunked transfer encoding",
    /Send header: Transfer-Encoding: chunked/i.test(pushSmall.stderr),
    "no chunked request header in the trace"
  );

  const big = crypto.randomBytes(4 * 1024 * 1024 + 123);
  write(a, "files/big.bin", big);
  await commitAll(a, "add 4M binary");
  const pushBig = await git(["-c", "http.postBuffer=65536", "push", "origin", "HEAD:master"], {
    cwd: a,
    env: TRACE,
  });
  check("push of a multi-MB binary succeeds", pushBig.code === 0, why(pushBig));
  check(
    "multi-MB push was chunked",
    /Send header: Transfer-Encoding: chunked/i.test(pushBig.stderr),
    "no chunked request header in the trace"
  );

  const wantHash = sha256(big);
  let lastGot = "";
  const blob = await until(async () => {
    const res = await raw("/files/big.bin", { host: BLOG_HOST });
    lastGot = "status " + res.status + ", " + res.body.length + " bytes";
    return { ok: res.status === 200 && sha256(res.body) === wantHash, detail: lastGot };
  });
  check("multi-MB binary is served by the blog byte for byte", blob.ok, blob.detail + ", want " + big.length + " bytes");

  const smallHash = sha256(small);
  const smallRes = await raw("/files/chunked-small.bin", { host: BLOG_HOST });
  check(
    "300k binary is served by the blog byte for byte",
    smallRes.status === 200 && sha256(smallRes.body) === smallHash,
    "status " + smallRes.status + ", " + smallRes.body.length + " bytes"
  );

  // 7. Fetching.
  // Give clone B enough local history the server has never seen that a fetch
  // has to negotiate with a long `have` list, big enough for git to gzip the
  // POST body (it gzips requests over 1024 bytes).
  const stream = [];
  for (let i = 0; i < 400; i++) {
    stream.push(
      "commit refs/heads/local-noise\n" +
        "committer E2E <e2e@example.com> " + (1600000000 + i) + " +0000\n" +
        "data 6\nnoise\n" +
        (i === 0 ? "" : "from refs/heads/local-noise^0\n") +
        "\n"
    );
  }
  const noise = await git(["fast-import", "--quiet"], { cwd: b, input: stream.join("") });
  check("local history for the have list created", noise.code === 0, why(noise));

  const fetchB = await git(["fetch", "origin"], { cwd: b, env: TRACE });
  check("incremental fetch from the second clone succeeds", fetchB.code === 0, why(fetchB));
  check(
    "fetch with a long have list sent a gzipped POST body",
    /Send header: Content-Encoding: gzip/i.test(fetchB.stderr),
    "no gzip request header in the trace"
  );
  const wantTip = await revParse(a);
  check("fetch brought origin/master to the pushed commit", (await revParse(b, "origin/master")) === wantTip);
  const merge = await git(["merge", "--ff-only", "origin/master"], { cwd: b });
  check("second clone fast-forwards", merge.code === 0, why(merge));
  const bigB = path.join(b, "files/big.bin");
  check(
    "second clone has the binary byte for byte",
    fs.existsSync(bigB) && sha256(fs.readFileSync(bigB)) === wantHash
  );
  const fsck = await git(["fsck", "--no-dangling"], { cwd: b });
  check("fetched repository passes fsck", fsck.code === 0, why(fsck));

  const fetchAgain = await git(["fetch", "origin"], { cwd: b });
  check("fetch with nothing new succeeds", fetchAgain.code === 0, why(fetchAgain));

  const shallow = newDir("shallow");
  const depth1 = await git(["clone", "--depth", "1", remoteURL(), shallow]);
  check("--depth 1 clone succeeds", depth1.code === 0, why(depth1));
  const count = (await git(["rev-list", "--count", "HEAD"], { cwd: shallow })).stdout.trim();
  const isShallow = (await git(["rev-parse", "--is-shallow-repository"], { cwd: shallow })).stdout.trim();
  check("--depth 1 clone has exactly one commit", count === "1" && isShallow === "true", "count " + count + ", shallow " + isShallow);
  check("--depth 1 clone is at the server tip", (await revParse(shallow)) === wantTip);

  let protoPushes = 0;
  for (const version of ["0", "2"]) {
    const dir = newDir("proto" + version);
    const clone = await git(["-c", "protocol.version=" + version, "clone", remoteURL(), dir]);
    check("clone with protocol.version=" + version + " succeeds", clone.code === 0, why(clone));
    if (clone.code !== 0) continue;
    check(
      "protocol.version=" + version + " clone is at the server tip",
      (await revParse(dir)) === (await remoteMaster())
    );
    write(dir, "proto/v" + version + ".bin", crypto.randomBytes(2048));
    await commitAll(dir, "push over protocol " + version);
    const push = await git(["-c", "protocol.version=" + version, "push", "origin", "HEAD:master"], {
      cwd: dir,
    });
    check("push with protocol.version=" + version + " succeeds", push.code === 0, why(push));
    check(
      "server master is the protocol " + version + " push",
      (await remoteMaster()) === (await revParse(dir))
    );
    protoPushes++;
  }

  // Bring clone A level with the protocol pushes (they came from other clones).
  const pullA = await git(["pull", "--ff-only", "origin", "master"], { cwd: a });
  check("first clone pulls the protocol pushes", pullA.code === 0 || protoPushes === 0, why(pullA));

  // 8. Only master may be pushed.
  const before = await git(["ls-remote", remoteURL()]);
  const other = await git(["push", "origin", "HEAD:refs/heads/not-master"], { cwd: a, timeout: 60000 });
  check("push to a branch other than master is rejected", other.code !== 0 && !other.timedOut, why(other));
  check(
    "the rejection says only master is allowed",
    /only the master branch/i.test(other.stderr),
    tail(other.stderr)
  );
  const after = await git(["ls-remote", remoteURL()]);
  check(
    "the rejected push created no branch",
    after.code === 0 && !/not-master/.test(after.stdout) && after.stdout === before.stdout,
    tail(after.stdout)
  );
  const stillWorks = await git(["fetch", "origin"], { cwd: a });
  check("the repository still serves after a rejected push", stillWorks.code === 0, why(stillWorks));

  // 9. A handle change: the old remote URL gets a 308 to the new one and still
  //    works for ls-remote, clone and push. Last, since it renames the repo.
  await renameStep(a, infoRefs);
}

function runContainerScript(args) {
  return new Promise((resolve) => {
    const compose = path.join(__dirname, "docker-compose.yml");
    const child = spawn(
      "docker",
      ["compose", "-f", compose, "exec", "-T", "app", "node", "/tmp/seed-git.js", ...args],
      { env: process.env }
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (err) => resolve({ code: -1, out: String(err) }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

async function renameStep(a, infoRefs) {
  if (!BLOG_ID) {
    console.log("  skip - rename: E2E_GIT_BLOG_ID not set");
    return;
  }
  const newHandle = HANDLE + "renamed";
  const renamed = await runContainerScript(["rename", BLOG_ID, newHandle]);
  check("handle changed in the app", renamed.code === 0 && /SEED_GIT_RENAMED/.test(renamed.out), tail(renamed.out));
  if (renamed.code !== 0) return;

  const oldPath = infoRefs(HANDLE);
  const newPath = infoRefs(newHandle);
  const redirect = await raw(oldPath);
  check(
    "old handle's info/refs answers 308 to the new handle, without credentials",
    redirect.status === 308 &&
      redirect.headers.location === "https://" + HOST + newPath,
    "status " + redirect.status + " location " + redirect.headers.location
  );

  const lsOld = await git(["ls-remote", remoteURL(HANDLE)]);
  const lsNew = await git(["ls-remote", remoteURL(newHandle)]);
  check("ls-remote on the old URL follows the redirect", lsOld.code === 0 && lsOld.stdout.length > 0, why(lsOld));
  check("old and new URL list the same refs", lsOld.stdout === lsNew.stdout, tail(lsOld.stdout) + " vs " + tail(lsNew.stdout));

  const oldClone = newDir("old-url-clone");
  const cloneOld = await git(["clone", remoteURL(HANDLE), oldClone]);
  check("clone from the old URL works", cloneOld.code === 0, why(cloneOld));

  if (cloneOld.code === 0) {
    write(oldClone, "proto/after-rename.bin", crypto.randomBytes(2048));
    await commitAll(oldClone, "push to the old URL");
    const push = await git(["push", "origin", "HEAD:master"], { cwd: oldClone });
    check("push to the old URL works", push.code === 0, why(push));
    check(
      "the new URL sees that push",
      (await remoteMaster(remoteURL(newHandle))) === (await revParse(oldClone))
    );
  }
}

main()
  .catch((err) => {
    failures++;
    console.log("  FAIL - git checks crashed ->", err && err.stack ? err.stack : err);
  })
  .finally(() => {
    try {
      fs.rmSync(workRoot, { recursive: true, force: true });
    } catch (e) {}
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  });
