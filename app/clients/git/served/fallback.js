// Brings a switched blog's EBS bare repository up to its store (#2259), so
// that switching the blog off (BLOT_GIT_STORE_SERVE) is an instant rollback.
// Nothing reads EBS for a switched blog: this only keeps it current.
//
//   request(blogID, { reason })   queues a fallback, unless one is already
//                                 waiting to start, which then covers this
//                                 request too (it reads both sides when it
//                                 starts). Resolves with its log line's
//                                 fields once it has run; never rejects.
//   run(blogID, { reason })       the same, now, outside the queue: for the
//                                 script (scripts/git/store-to-ebs.js)
//   idle(blogID)                  resolves once none is queued or running
//
// A fallback:
//
//   1. reads the store's manifest and EBS's master and tags (other branches
//      can't be pushed, and are left alone);
//   2. if they differ and EBS lacks objects, asks the store's own serve() for
//      a pack of the store's tips with EBS's tips as haves, which is what a
//      `git fetch` from the store would get, and streams it into
//      `git index-pack --stdin --fix-thin` in a quarantine directory of the
//      EBS repository (sweepQuarantine.js cleans up after a crash);
//   3. under the ref lock, checks that EBS's refs have not moved since step 1,
//      moves the pack out of quarantine, and moves the refs in one
//      `update-ref --stdin` with each old value; then schedules a gc, as
//      after a push.
//
// Each blog has one queue in this process, run in the git limiter's
// background lane. A failure is logged and left for the next store write, or
// the daily verifier, to try again:
//
//   [git-store-served] blog=<id> op=fallback outcome=current|ok|moved|skipped|error
//     ms=... refs=... bytesDown=... detail=...
const fs = require("fs-extra");
const path = require("path");
const { spawn } = require("child_process");
const { PassThrough, Transform } = require("stream");
const { pipeline } = require("stream/promises");
const limiter = require("../limiter");
const receivePack = require("../receivePack");
const gc = require("../gc");
const QUARANTINE_PREFIX = require("../sweepQuarantine").PREFIX;
const { serve } = require("../store/clone");
const manifest = require("../store/manifest");
const pktline = require("../store/pktline");
const { measure } = require("../shadow/counting");
const context = require("./context");
const log = require("./log");

const ZERO = "0".repeat(40);
const MASTER = "refs/heads/master";

// How long after being asked a fallback starts, so a burst of writes shares one
const START_DELAY_MS = 250;

const GIT_TIMEOUT_MS = 60 * 60 * 1000;
const SHORT_TIMEOUT_MS = 30 * 1000;
const STDERR_BYTES = 4096;

// The refs a fallback keeps equal: master and the tags
function kept(ref) {
  return ref === MASTER || ref.indexOf("refs/tags/") === 0;
}

function only(refs) {
  return Object.fromEntries(Object.entries(refs).filter(([ref]) => kept(ref)));
}

// ---- Git in the EBS repository --------------------------------------------

// Runs git in the repository once there is a place in the background lane
// (or in the place this context already holds). Resolves with
// { code, stdout, stderr } whatever the exit code. options: input, env,
// timeout, stdin (a function given the child's stdin to write to instead of
// input).
function git(gitDir, args, options = {}) {
  return limiter.run("background", () => new Promise((resolve, reject) => {
    const child = spawn("git", limiter.args(args), {
      cwd: gitDir,
      env: Object.assign({}, process.env, { GIT_DIR: gitDir, GIT_TERMINAL_PROMPT: "0" }, options.env),
      stdio: ["pipe", "pipe", "pipe"],
      timeout: options.timeout || SHORT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const stdout = [];
    let stderr = "";
    let feeding = null;

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => {
      if (stderr.length < STDERR_BYTES) stderr += chunk;
    });
    child.stdin.on("error", () => {});
    child.on("error", reject);
    child.on("close", (code, signal) => {
      Promise.resolve(feeding)
        .catch(() => {})
        .then(() => resolve({ code: signal ? 1 : code, stdout: Buffer.concat(stdout).toString(), stderr }));
    });

    if (options.stdin) feeding = options.stdin(child.stdin);
    else child.stdin.end(options.input);
  }));
}

async function gitOk(gitDir, args, options) {
  const result = await git(gitDir, args, options);
  if (result.code) throw new Error("git " + args[0] + " failed: " + result.stderr.trim());
  return result.stdout;
}

async function ebsRefs(gitDir) {
  const output = await gitOk(gitDir, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"]);
  const refs = {};

  for (const line of output.split("\n")) {
    if (!line) continue;
    const space = line.indexOf(" ");
    refs[line.slice(space + 1)] = line.slice(0, space);
  }

  return refs;
}

// Which of the objects the EBS repository lacks
async function missingFrom(gitDir, oids) {
  if (!oids.length) return [];
  const output = await gitOk(gitDir, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: oids.join("\n") + "\n" });
  return output
    .split("\n")
    .filter((line) => / missing$/.test(line))
    .map((line) => line.split(" ")[0]);
}

// ---- The pack from the store ----------------------------------------------

// Passes on the pack in an upload-pack answer without side-band: the
// acknowledgement's pkt-lines come first, then the raw pack. An ERR packet,
// or an answer with no pack, is an error.
function unwrap() {
  let buffer = Buffer.alloc(0);
  let inPack = false;

  return new Transform({
    transform(chunk, encoding, callback) {
      if (inPack) return callback(null, chunk);

      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 4) {
        const head = buffer.toString("latin1", 0, 4);

        if (head === "PACK") {
          inPack = true;
          const rest = buffer;
          buffer = null;
          return callback(null, rest);
        }

        if (!/^[0-9a-f]{4}$/.test(head)) return callback(new Error("the store's answer is not git"));

        const length = parseInt(head, 16);
        if (length === 0) {
          buffer = buffer.subarray(4);
          continue;
        }
        if (length < 4) return callback(new Error("the store's answer is not git"));
        if (buffer.length < length) break;

        const line = buffer.toString("utf8", 4, length);
        buffer = buffer.subarray(length);
        if (line.indexOf("ERR ") === 0) return callback(new Error("the store refused: " + line.slice(4).trim()));
      }

      callback();
    },
    flush(callback) {
      callback(inPack ? null : new Error("the store sent no pack"));
    },
  });
}

// The upload-pack request for `wants`, with `haves`, done: no side-band, no
// progress, so the answer is the acknowledgement and then the pack
function requestFor(wants, haves) {
  const lines = wants.map((oid, i) => pktline.packet("want " + oid + (i === 0 ? " ofs-delta no-progress" : "") + "\n"));
  lines.push(pktline.FLUSH);
  for (const oid of haves) lines.push(pktline.packet("have " + oid + "\n"));
  lines.push(pktline.packet("done\n"));
  return Buffer.concat(lines);
}

// Streams what EBS lacks from the store into a new quarantine directory of
// the repository. Resolves with the quarantine directory.
async function fetchInto(gitDir, { store, cache, current, wants, haves }) {
  const quarantine = await fs.mkdtemp(path.join(gitDir, "objects", QUARANTINE_PREFIX));

  try {
    await fs.ensureDir(path.join(quarantine, "pack"));

    // One place in the background lane for the whole transfer: the read from
    // the store and index-pack go at the same pace
    await limiter.run("background", async () => {
      const out = new PassThrough();
      let served = null;

      const result = await git(gitDir, ["index-pack", "--stdin", "--fix-thin"], {
        timeout: GIT_TIMEOUT_MS,
        env: { GIT_OBJECT_DIRECTORY: quarantine, GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(gitDir, "objects") },
        stdin: (stdin) => {
          served = serve({ store, cache, manifest: current, body: requestFor(wants, haves), out, limiter: null });
          served.catch(() => out.destroy());
          return pipeline(out, unwrap(), stdin);
        },
      });

      // What went wrong in the store, if anything did, says more than git;
      // unless all it saw was index-pack stopping early
      const outcome = await Promise.resolve(served).then(
        (value) => ({ value }),
        (err) => ({ err })
      );
      if (outcome.err && !(result.code && outcome.err.code === "CLIENT_GONE")) throw outcome.err;
      if (outcome.value && outcome.value.refused) throw new Error("the store refused: " + outcome.value.refused);
      if (result.code) throw new Error("git index-pack failed: " + result.stderr.trim());
    });

    return quarantine;
  } catch (err) {
    await fs.remove(quarantine).catch(() => {});
    throw err;
  }
}

// ---- One fallback -----------------------------------------------------------

async function blogOf(blogID) {
  return new Promise((resolve, reject) => {
    require("models/blog").get({ id: blogID }, (err, blog) => (err ? reject(err) : resolve(blog)));
  });
}

function sameRefs(a, b) {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const name of names) if (a[name] !== b[name]) return false;
  return true;
}

// The update-ref --stdin input that makes EBS's kept refs the store's
function updatesFor(ebs, target) {
  const lines = [];
  for (const ref of [...new Set([...Object.keys(ebs), ...Object.keys(target)])].sort()) {
    const from = ebs[ref] || ZERO;
    const to = target[ref] || ZERO;
    if (from === to) continue;
    if (to === ZERO) lines.push("delete " + ref + " " + from + "\n");
    else if (from === ZERO) lines.push("create " + ref + " " + to + "\n");
    else lines.push("update " + ref + " " + to + " " + from + "\n");
  }
  return lines;
}

async function fallback(blogID) {
  const blog = await blogOf(blogID);
  if (!blog || blog.client !== "git" || !blog.handle) return { outcome: "skipped", detail: "the blog is gone or off git" };

  const repo = require("../repo");
  const gitDir = repo.directory(blog.handle);
  if (!(await fs.pathExists(gitDir))) return { outcome: "skipped", detail: "no EBS repository" };

  const store = context.storeFor(blogID);
  const cache = context.cache();
  const current = await manifest.read(store);

  // Never an empty store over EBS
  if (manifest.isEmpty(current)) return { outcome: "skipped", detail: "the store has no copy" };

  const target = only(current.refs);
  const before = await ebsRefs(gitDir);
  const ebs = only(before);

  if (sameRefs(ebs, target)) return { outcome: "current", refs: 0 };

  const wants = [...new Set(Object.values(target))].filter((oid) => !Object.values(ebs).includes(oid));
  const lacking = await missingFrom(gitDir, wants);
  const haves = [...new Set(Object.values(before))];
  const quarantine = lacking.length ? await fetchInto(gitDir, { store, cache, current, wants: lacking, haves }) : null;

  try {
    const release = await repo.holdRefLock(blogID);

    try {
      // Anything that moved EBS's refs meanwhile is left alone; the next
      // fallback starts again from both sides
      if (!sameRefs(await ebsRefs(gitDir), before)) return { outcome: "moved" };

      if (quarantine) await receivePack.migrate({ quarantine, directory: gitDir });

      const updates = updatesFor(ebs, target);
      await gitOk(gitDir, ["update-ref", "--stdin"], { input: updates.join("") });

      gc.schedule(gitDir);
      return { outcome: "ok", refs: updates.length };
    } finally {
      await Promise.resolve()
        .then(release)
        .catch(() => {});
    }
  } finally {
    if (quarantine) await fs.remove(quarantine).catch(() => {});
  }
}

// Never rejects: what happened is the log line's fields
async function run(blogID, { reason } = {}) {
  let fields;

  try {
    const measured = await measure(() => fallback(blogID));
    fields = { ...measured.result, ms: measured.ms, requests: measured.counts.requests, bytesDown: measured.counts.bytesDown, waitMs: measured.counts.waitMs };
  } catch (err) {
    fields = { outcome: "error", detail: scrub(err) };
  }

  fields = { blog: blogID, op: "fallback", ...fields, reason };
  log(fields);
  return fields;
}

// An error's message without the repository's path (which has the handle)
function scrub(err) {
  return String((err && (err.message || err)) || "error")
    .replace(/\/[^\s'"]*\.git\b/g, "<repo>")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- The queue --------------------------------------------------------------

// blogID -> { chain, pending }
const blogs = new Map();

function request(blogID, { reason } = {}) {
  let state = blogs.get(blogID);

  if (!state) {
    state = { chain: Promise.resolve(), pending: null };
    blogs.set(blogID, state);
  }

  if (state.pending) return state.pending;

  const pending = limiter.outside(() =>
    state.chain
      .then(() => new Promise((resolve) => setTimeout(resolve, START_DELAY_MS)))
      .then(() => {
        // Started: a request from now on queues another
        if (state.pending === pending) state.pending = null;
        return run(blogID, { reason });
      })
  );

  state.pending = pending;
  state.chain = pending.catch(() => {});

  const chain = state.chain;
  chain.then(() => {
    if (state.chain === chain && !state.pending && blogs.get(blogID) === state) blogs.delete(blogID);
  });

  return pending;
}

function idle(blogID) {
  const state = blogs.get(blogID);
  return state ? state.chain.then(() => idle(blogID)) : Promise.resolve();
}

module.exports = { request, run, idle, _requestFor: requestFor, _unwrap: unwrap, _fetchInto: fetchInto };
