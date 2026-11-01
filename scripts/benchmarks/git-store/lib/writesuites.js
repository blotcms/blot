// The write-side measurements: pushes from a real git client, Blot's own
// one-file commits, and the 300-commit upload.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { withSession, summarise, WORK, median } = require("./session");
const { generateAndUpload } = require("./upload");
const { randomBytes } = require("./generate");
const { loadMeta, metaPath, verifyWithGit } = require("./readsuites");
const { connect } = require("./stores");

const run = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });

// ---- a client to push from ---------------------------------------------------

// `large` has a prepared partial clone (see README: clone-large is made with
// a blob size filter, sparse to posts/ and templates/); other repositories get
// a full clone
async function clientFor(repo, profile) {
  const dir = path.join(WORK, "client-" + repo);
  if (repo === "large") {
    if (!fs.existsSync(dir)) throw new Error("Make the partial clone " + dir + " first (README)");
    return dir;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  await withSession({ blogID: repo, profile: "direct" }, async (server) => {
    execFileSync("git", ["clone", "-q", server.gitUrl, dir], { stdio: "ignore" });
  });
  run(dir, "config", "user.email", "spike@example.com");
  run(dir, "config", "user.name", "Spike");
  return dir;
}

function posts(dir) {
  return run(dir, "ls-files", "posts").split("\n").filter((p) => p.endsWith(".md"));
}

let counter = 0;

function editPost(dir, rand) {
  const list = posts(dir);
  const file = list[Math.floor(rand() * list.length)];
  const lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
  lines[2 + Math.floor(rand() * Math.max(1, lines.length - 3))] = "Edited " + ++counter + " at " + Date.now() + " " + Math.floor(rand() * 1e9);
  fs.writeFileSync(path.join(dir, file), lines.join("\n"));
  return file;
}

// A push of `commits` commits, each editing two posts, with an image added to
// every `imageEvery`th. Returns what was pushed.
function makeChange(dir, { commits, imageEvery = 0, imageBytes = 400000, rand }) {
  let images = 0;
  for (let i = 0; i < commits; i++) {
    const files = [editPost(dir, rand), editPost(dir, rand)];
    if (imageEvery && i % imageEvery === 0) {
      const name = "images/2031/spike-" + ++counter + ".jpg";
      fs.mkdirSync(path.join(dir, "images/2031"), { recursive: true });
      fs.writeFileSync(path.join(dir, name), randomBytes(counter * 31 + 7, imageBytes));
      run(dir, "add", "--sparse", name);
      images++;
    }
    run(dir, "add", "--sparse", ...new Set(files));
    run(dir, "commit", "-q", "-m", "Change " + counter);
  }
  return { commits, images };
}

function seededRandom(seed) {
  return require("./generate").mulberry32(seed);
}

async function pushSuite({ repo, profile, record }) {
  const dir = await clientFor(repo, profile);
  const rand = seededRandom(Date.now() % 1e6);

  await withSession({ blogID: repo, profile }, async (server) => {
    run(dir, "remote", "set-url", "origin", server.gitUrl);
    run(dir, "fetch", "-q", "origin");
    await server.take();

    const cases = [
      ["one file", "cold", { commits: 1 }],
      ["one file", "warm", { commits: 1 }],
      ["medium", "warm", { commits: 30, imageEvery: 2 }],
    ];
    for (const [label, phase, change] of cases) {
      const made = makeChange(dir, { ...change, rand });
      const started = Date.now();
      const result = require("child_process").spawnSync("git", ["push", "-q", "origin", "master"], { cwd: dir, encoding: "utf8" });
      const ms = Date.now() - started;
      // the server notes what a push did just after it has answered
      await new Promise((resolve) => setTimeout(resolve, 500));
      const taken = await server.take();
      // git first posts a 4-byte probe for a large push, which is a receive-pack request too
      const fact = taken.facts.filter((f) => f.op === "receive-pack" && f.newObjects !== undefined).pop() || {};
      const remote = run(dir, "ls-remote", "origin", "refs/heads/master").split("\t")[0];
      record({
        suite: "push",
        repo,
        profile,
        phase,
        change: label,
        commits: made.commits,
        images: made.images,
        ok: result.status === 0 && remote === run(dir, "rev-parse", "HEAD").trim(),
        stderr: result.status === 0 ? undefined : result.stderr.slice(0, 300),
        ms,
        serverMs: fact.ms,
        packBytesIn: fact.packBytesIn,
        thinBaseCandidates: fact.baseCandidates,
        thinBasesFetched: fact.basesFetched,
        thinBaseBytes: fact.baseBytes,
        newObjects: fact.newObjects,
        referentsChecked: fact.referentsChecked,
        packBytesOut: fact.packBytesOut,
        stepsMs: { receive: fact.receiveMs, scan: fact.scanMs, bases: fact.basesMs, indexPack: fact.indexPackMs, connectivity: fact.connectivityMs, upload: fact.uploadMs, swap: fact.swapMs },
        seq: fact.seq,
        manifestBytes: fact.manifestBytes,
        ...summarise(taken),
      });
    }
  });

  if (repo !== "large") {
    const verifyDir = path.join(WORK, "verify-" + repo);
    await withSession({ blogID: repo, profile: "direct" }, async (server) => {
      const check = verifyWithGit(server.gitUrl, verifyDir);
      record({ suite: "push-verify", repo, profile, phase: "real git clone + fsck --strict after the pushes", ...check });
    });
  }
}

// ---- Blot's one-file commit --------------------------------------------------

async function commitSuite({ repo, profile, record, count = 1 }) {
  await withSession({ blogID: repo, profile }, async (server) => {
    for (const phase of ["cold", "warm"]) {
      const started = Date.now();
      const out = await server.op("commit", { file: "posts/2031/01/spike-" + phase + ".md", content: "A post written by Blot at " + Date.now() + "\n" });
      const ms = Date.now() - started;
      const taken = await server.take();
      record({ suite: "commit", repo, profile, phase, ms, objects: out.objects, packBytes: out.packBytes, seq: out.seq, manifestBytes: out.manifestBytes, ...summarise(taken) });
    }
  });
}

// 300 one-file commits in a row, as a 300-file upload makes them: each is a
// commit, a pack, a manifest swap. Starts from a freshly built blog repository.
async function commit300({ profile, record, total = 300 }) {
  const repo = "blog";
  await generateAndUpload({ specName: "blog", blogID: repo, workDir: path.join(WORK, "build-blog"), metaFile: metaPath(repo), log: () => {} });
  const before = loadMeta(repo);

  await withSession({ blogID: repo, profile }, async (server) => {
    await server.take();
    const times = [];
    const started = Date.now();
    let last;
    for (let i = 0; i < total; i++) {
      const t = Date.now();
      last = await server.op("commit", { file: "posts/2032/02/upload-" + i + ".md", content: "Upload " + i + "\n" + "x".repeat(200) + "\n" });
      times.push(Date.now() - t);
    }
    const ms = Date.now() - started;
    const taken = await server.take();

    // What is left behind
    const direct = connect({ blogID: repo, via: "direct" });
    const objects = { manifests: 0, manifestBytes: 0, packs: 0, packBytes: 0 };
    for await (const item of direct.store.list("")) {
      if (/^manifests\/\d+\.json$/.test(item.key)) {
        objects.manifests++;
        objects.manifestBytes += item.size;
      } else if (item.key.endsWith(".pack")) {
        objects.packs++;
        objects.packBytes += item.size;
      }
    }
    direct.close();

    record({
      suite: "commit300",
      repo,
      profile,
      commits: total,
      ms,
      perCommitMedianMs: median(times),
      perCommitP95Ms: [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.95)],
      firstMs: times[0],
      packsBefore: before.packs.length,
      manifestBytesBefore: before.manifestBytes,
      manifestBytesAfter: last.manifestBytes,
      leftBehind: objects,
      ...summarise(taken),
    });

    // The state afterwards: what a reader of it pays now
    const adv = await require("./client").advertise(server.gitUrl);
    const after = summarise(await server.take());
    record({ suite: "after300", repo, profile, phase: "advertise (warm)", ms: adv.ms, ...after });
    await server.clearCache();
    const adv2 = await require("./client").advertise(server.gitUrl);
    record({ suite: "after300", repo, profile, phase: "advertise (cold)", ms: adv2.ms, ...summarise(await server.take()) });
    const one = await server.op("commit", { file: "posts/2032/02/after.md", content: "after\n" });
    record({ suite: "after300", repo, profile, phase: "one commit (cold)", ms: one.ms, ...summarise(await server.take()) });
  });
}

module.exports = { pushSuite, commitSuite, commit300 };
