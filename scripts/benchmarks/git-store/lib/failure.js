// Failure injection with toxiproxy: connection resets and stalls during a
// clone, a ranged read, a multipart upload and a push. For each: does the
// store retry, does it fail clearly, and is any wrong data ever returned or
// acknowledged?
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
const { Readable } = require("stream");
const { ListMultipartUploadsCommand } = require("@aws-sdk/client-s3");
const toxiproxy = require("./toxiproxy");
const { connect, BUCKET } = require("./stores");
const { withSession, summarise, WORK } = require("./session");
const { loadMeta } = require("./readsuites");
const client = require("./client");
const { randomBytes } = require("./generate");
const { layout } = require("../../../../app/clients/git/store");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves with the outcome, or "hung" if it takes longer than `ms`
async function within(ms, promise) {
  let timer;
  const limit = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ hung: true }), ms);
  });
  try {
    return await Promise.race([promise.then((value) => ({ value }), (error) => ({ error })), limit]);
  } finally {
    clearTimeout(timer);
  }
}

const sha = (buffer) => crypto.createHash("sha1").update(buffer).digest("hex");

async function reset(toxic) {
  await toxiproxy.clear();
  if (toxic) await toxiproxy.add({ name: "fault", ...toxic });
}

// ---- a ranged read -----------------------------------------------------------

async function rangedRead({ record }) {
  const meta = loadMeta("blog");
  const pack = meta.packs[0];
  const key = layout.packKey(pack.name);
  const length = 256 * 1024;

  const direct = connect({ blogID: "blog", via: "direct" });
  const expected = [];
  for (let i = 0; i < 40; i++) expected.push(sha(await direct.store.read(key, i * 100000, length)));
  direct.close();

  const cases = [
    ["30% of connections cut after 64 KB of the response", { type: "limit_data", stream: "downstream", toxicity: 0.3, attributes: { bytes: 65536 } }, {}],
    ["30% of connections reset at once", { type: "reset_peer", stream: "downstream", toxicity: 0.3, attributes: { timeout: 0 } }, {}],
    ["every connection reset", { type: "reset_peer", stream: "downstream", toxicity: 1, attributes: { timeout: 0 } }, {}],
    ["30% of connections stall, no request timeout", { type: "timeout", stream: "downstream", toxicity: 0.3, attributes: { timeout: 0 } }, { requestTimeout: 0, limit: 15000 }],
    ["30% of connections stall, 3 s request timeout", { type: "timeout", stream: "downstream", toxicity: 0.3, attributes: { timeout: 0 } }, { requestTimeout: 3000, limit: 180000 }],
  ];

  for (const [label, toxic, options] of cases) {
    await reset(toxic);
    const conn = connect({ blogID: "blog", via: "proxied", options: { requestTimeout: options.requestTimeout || 0, keepAlive: false } });
    const outcome = { ok: 0, errors: 0, hung: 0, wrong: 0, messages: new Set() };
    const started = Date.now();
    for (let i = 0; i < 40; i++) {
      const result = await within(options.limit || 60000, conn.store.read(key, i * 100000, length));
      if (result.hung) {
        outcome.hung++;
        break;
      }
      if (result.error) {
        outcome.errors++;
        outcome.messages.add(String(result.error.name + ": " + result.error.message).slice(0, 80));
      } else if (sha(result.value) !== expected[i]) outcome.wrong++;
      else outcome.ok++;
    }
    const counts = conn.counters.take();
    const attempts = Object.values(counts.http).reduce((n, r) => n + r.n, 0);
    record({ suite: "failure", scenario: "ranged read", case: label, ...outcome, messages: [...outcome.messages], reads: outcome.ok + outcome.errors + outcome.wrong + outcome.hung, requestAttempts: attempts, ms: Date.now() - started });
    conn.close();
  }
  await toxiproxy.clear();
}

// ---- a multipart upload ------------------------------------------------------

async function openUploads(blogID) {
  const direct = connect({ blogID, via: "direct" });
  const out = await direct.client.send(new ListMultipartUploadsCommand({ Bucket: BUCKET, Prefix: direct.prefix }));
  direct.close();
  return (out.Uploads || []).length;
}

async function multipart({ record }) {
  const size = 40 * 1024 * 1024;
  const body = randomBytes(77, size);
  const want = sha(body);
  const stream = () => Readable.from((function* () { for (let at = 0; at < size; at += 1 << 20) yield body.subarray(at, at + (1 << 20)); })());

  const cases = [
    ["connection cut 30% of the time, mid-part", { type: "reset_peer", stream: "upstream", toxicity: 0.3, attributes: { timeout: 30 } }, {}],
    ["every connection cut mid-part", { type: "reset_peer", stream: "upstream", toxicity: 1, attributes: { timeout: 30 } }, {}],
    ["stall 30% of connections, no request timeout", { type: "timeout", stream: "upstream", toxicity: 0.3, attributes: { timeout: 0 } }, { limit: 15000 }],
    ["stall 30% of connections, 5 s request timeout", { type: "timeout", stream: "upstream", toxicity: 0.3, attributes: { timeout: 0 } }, { requestTimeout: 5000, limit: 180000 }],
  ];

  for (const [label, toxic, options] of cases) {
    await reset(toxic);
    const key = "packs/pack-" + "0".repeat(39) + "1.pack";
    const conn = connect({ blogID: "failure-upload", via: "proxied", options: { requestTimeout: options.requestTimeout || 0, keepAlive: false } });
    const started = Date.now();
    const result = await within(options.limit || 120000, conn.store.put(key, stream()));
    const counts = conn.counters.take();
    const attempts = Object.values(counts.http).reduce((n, r) => n + r.n, 0);
    conn.close();

    await toxiproxy.clear();
    await sleep(options.limit && result.hung ? 20000 : 0);
    const check = connect({ blogID: "failure-upload", via: "direct" });
    const present = await check.store.head(key);
    let intact = null;
    if (present) intact = sha(await check.store.read(key, 0, size)) === want && present.size === size;
    if (present) await check.store.delete(key);
    check.close();

    record({
      suite: "failure",
      scenario: "multipart upload",
      case: label,
      outcome: result.hung ? "hung" : result.error ? "failed: " + String(result.error.message).slice(0, 80) : "completed",
      objectVisible: !!present,
      objectIntact: intact,
      incompleteUploadsLeft: await openUploads("failure-upload"),
      requestAttempts: attempts,
      ms: Date.now() - started,
    });
  }
}

// ---- a clone -----------------------------------------------------------------

async function cloneFailures({ record }) {
  const meta = loadMeta("blog");
  const tip = meta.refs["refs/heads/master"];
  const cases = [
    ["reset 20% of connections", { type: "reset_peer", stream: "downstream", toxicity: 0.2, attributes: { timeout: 30 } }, { SPIKE_KEEPALIVE: "0" }, true],
    ["every connection reset", { type: "reset_peer", stream: "downstream", toxicity: 1, attributes: { timeout: 30 } }, { SPIKE_KEEPALIVE: "0" }, false],
    ["every connection cut after 1 MB (limit_data)", { type: "limit_data", stream: "downstream", toxicity: 1, attributes: { bytes: 1048576 } }, { SPIKE_KEEPALIVE: "0" }, false],
    ["20% of connections cut after 1 MB (limit_data)", { type: "limit_data", stream: "downstream", toxicity: 0.2, attributes: { bytes: 1048576 } }, { SPIKE_KEEPALIVE: "0" }, true],
    ["stall 20% of connections, no request timeout", { type: "timeout", stream: "downstream", toxicity: 0.2, attributes: { timeout: 0 } }, { SPIKE_KEEPALIVE: "0" }, null],
    ["stall 5% of connections, 3 s request timeout", { type: "timeout", stream: "downstream", toxicity: 0.05, attributes: { timeout: 0 } }, { SPIKE_REQUEST_TIMEOUT: "3000", SPIKE_KEEPALIVE: "0" }, true],
  ];

  for (const [label, toxic, env, expectOk] of cases) {
    await toxiproxy.useProfile("direct");
    await withSession({ blogID: "blog", profile: "direct", via: "proxied", env }, async (server) => {
      await reset(toxic);
      const started = Date.now();
      const raw = await within(expectOk === null ? 25000 : 120000, client.clone(server.gitUrl, [tip]));
      const ms = Date.now() - started;
      const taken = await server.take().catch(() => null);

      // The same with a real git client: it must either end with a repository
      // which passes fsck, or fail and leave nothing behind
      await toxiproxy.clear();
      const dest = path.join(WORK, "failure-clone");
      fs.rmSync(dest, { recursive: true, force: true });
      await reset(toxic);
      const real = raw.hung
        ? { status: "skipped (the raw clone hung)" }
        : spawnSync("git", ["clone", "--bare", "-q", server.gitUrl, dest], { encoding: "utf8", timeout: 120000 });
      let fsckOk = null;
      if (real.status === 0) fsckOk = spawnSync("git", ["--git-dir=" + dest, "fsck", "--strict"]).status === 0;
      fs.rmSync(dest, { recursive: true, force: true });
      await toxiproxy.clear();

      record({
        suite: "failure",
        scenario: "clone",
        case: label,
        outcome: raw.hung ? "hung" : raw.error ? "failed: " + String(raw.error.cause ? raw.error.cause.message : raw.error.message).slice(0, 80) : raw.value.trailerOk ? "completed, pack checksum valid" : "completed, CHECKSUM WRONG",
        gitCloneExit: real.status,
        gitStderr: real.stderr ? real.stderr.split("\n")[0].slice(0, 100) : undefined,
        gitFsckOk: fsckOk,
        requestAttempts: taken ? summarise(taken).requests : null,
        serverErrors: taken ? taken.facts.filter((f) => f.op === "error").length : null,
        ms,
      });
    });
  }
}

// ---- a push ------------------------------------------------------------------

async function pushFailures({ record }) {
  const manifestSeq = async (server) => {
    const adv = await client.advertise(server.gitUrl, "git-receive-pack");
    return adv.refs;
  };
  const dir = path.join(WORK, "client-blog");
  const run = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (!fs.existsSync(dir)) throw new Error("Run the push suite on blog first (it makes the client)");

  let n = 0;
  const change = () => {
    fs.writeFileSync(path.join(dir, "failure-" + Date.now() + "-" + ++n + ".md"), "failure test " + n + " " + "y".repeat(300) + "\n");
    run("add", ".");
    run("commit", "-q", "-m", "failure " + n);
  };

  const scenarios = [
    ["pack upload fails (every connection cut)", { upload: { type: "reset_peer", stream: "upstream", toxicity: 1, attributes: { timeout: 0 } } }, "should-fail"],
    ["manifest write: response lost, every attempt", { swap: { type: "reset_peer", stream: "downstream", toxicity: 1, attributes: { timeout: 0 } } }, "swap"],
    ["manifest write: response lost on 50% of attempts", { swap: { type: "reset_peer", stream: "downstream", toxicity: 0.5, attributes: { timeout: 0 } } }, "swap"],
  ];

  for (const [label, faults, kind] of scenarios) {
    const trials = kind === "should-fail" ? 3 : 8;
    const tally = { acknowledged: 0, rejected: 0, rejectedButLanded: 0, acknowledgedButMissing: 0, messages: new Set(), trials: [] };
    await toxiproxy.useProfile("direct");
    await withSession({ blogID: "blog", profile: "direct", via: "proxied", attempts: 3, env: { SPIKE_REQUEST_TIMEOUT: "5000" } }, async (server) => {
      run("remote", "set-url", "origin", server.gitUrl);
      run("fetch", "-q", "origin");
      for (let t = 0; t < trials; t++) {
        await toxiproxy.clear();
        const before = (await manifestSeq(server))["refs/heads/master"];
        change();
        const head = run("rev-parse", "HEAD").trim();
        await server.config({ faults });
        const push = spawnSync("git", ["push", "origin", "master"], { cwd: dir, encoding: "utf8", timeout: 120000 });
        await toxiproxy.clear();
        await server.config({ faults: { upload: null, swap: null } });
        const after = (await manifestSeq(server))["refs/heads/master"];
        const acknowledged = push.status === 0;
        const taken = await server.take();
        const fact = taken.facts.filter((f) => f.op === "receive-pack" && f.newObjects !== undefined).pop() || {};
        tally.trials.push({ acknowledged, landed: after === head, serverError: fact.error && fact.error.slice(0, 80), seq: fact.seq, hintFailures: taken.hintFailures });
        if (acknowledged) {
          tally.acknowledged++;
          if (after !== head) tally.acknowledgedButMissing++;
        } else {
          tally.rejected++;
          tally.messages.add(push.stderr.split("\n").filter((l) => /rejected|error|failed|remote:/i.test(l)).slice(0, 2).join(" | ").slice(0, 160));
          if (after === head) tally.rejectedButLanded++;
          // the client resets to what the server has, so the next trial starts clean
          if (after !== before && after !== head) throw new Error("the ref moved to something unexpected");
        }
        run("fetch", "-q", "origin");
        run("reset", "-q", "--hard", "origin/master");
      }
    });
    record({ suite: "failure", scenario: "push", case: label, ...tally, trials, trialLog: tally.trials, messages: [...tally.messages] });
  }
}

async function failureSuite({ record }) {
  await rangedRead({ record });
  await multipart({ record });
  await cloneFailures({ record });
  await pushFailures({ record });
  await toxiproxy.useProfile("direct");
}

module.exports = { failureSuite, rangedRead, multipart, cloneFailures, pushFailures };
