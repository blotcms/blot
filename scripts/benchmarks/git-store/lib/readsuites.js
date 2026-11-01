// The read-side measurements: ref advertisement, full clone, incremental
// fetch and materialize.
const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const client = require("./client");
const { withSession, summarise, median, WORK } = require("./session");

const metaPath = (name) => path.join(WORK, "meta", name + ".json");
const loadMeta = (name) => JSON.parse(fs.readFileSync(metaPath(name), "utf8"));
const git = (dir, ...args) => execFileSync("git", ["--git-dir=" + dir, ...args], { encoding: "utf8", maxBuffer: 1 << 29 });

// ---- ref advertisement ---------------------------------------------------

async function advertisement({ repo, profile, record }) {
  await withSession({ blogID: repo, profile }, async (server) => {
    const timeIt = async () => {
      const result = await client.advertise(server.gitUrl);
      return { ms: result.ms, taken: await server.take() };
    };

    const cold = await timeIt();
    record({ suite: "advertise", repo, profile, phase: "cold", ms: cold.ms, ...summarise(cold.taken) });

    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(await timeIt());
    const ms = median(runs.map((r) => r.ms));
    record({ suite: "advertise", repo, profile, phase: "warm", ms, ...summarise(runs[0].taken) });
  });
}

// ---- full clone ----------------------------------------------------------

function verifyWithGit(url, scratch) {
  fs.rmSync(scratch, { recursive: true, force: true });
  const started = Date.now();
  const clone = spawnSync("git", ["-c", "transfer.fsckObjects=true", "clone", "--bare", "-q", url, scratch], { encoding: "utf8" });
  const fsck = clone.status === 0 ? spawnSync("git", ["--git-dir=" + scratch, "fsck", "--strict"], { encoding: "utf8", maxBuffer: 1 << 29 }) : { status: -1 };
  const objects = clone.status === 0 ? git(scratch, "count-objects", "-v").match(/in-pack: (\d+)/)[1] : null;
  fs.rmSync(scratch, { recursive: true, force: true });
  return { cloneOk: clone.status === 0, fsckOk: fsck.status === 0, objects: Number(objects), ms: Date.now() - started };
}

async function cloneSuite({ repo, profile, record, verify = false }) {
  const meta = loadMeta(repo);
  const tip = meta.refs["refs/heads/master"];
  await withSession({ blogID: repo, profile }, async (server) => {
    for (const phase of ["cold", "warm"]) {
      const result = await client.clone(server.gitUrl, [tip]);
      const taken = await server.take();
      const fact = taken.facts.find((f) => f.op === "upload-pack") || {};
      record({
        suite: "clone",
        repo,
        profile,
        phase,
        ms: result.ms,
        firstByteMs: result.firstByteMs,
        packBytes: result.packBytes,
        objects: result.objects,
        skipped: fact.skipped,
        trailerOk: result.trailerOk,
        trailer: result.trailer,
        serverMs: fact.ms,
        ...summarise(taken),
      });
    }

    if (verify) {
      const check = verifyWithGit(server.gitUrl, path.join(WORK, "verify-" + repo));
      const taken = await server.take();
      record({ suite: "clone-git", repo, profile, phase: "real git clone + fsck --strict", ...check, ...summarise(taken) });
    }
  });
}

// ---- incremental fetch ---------------------------------------------------

// The commit that ended push `seq` (the master tip after it)
function tipAfterPush(meta, seq) {
  let index = -1;
  for (const pack of meta.packs.slice(0, seq)) index += pack.commits;
  return meta.commits[index];
}

async function fetchSuite({ repo, profile, record, behind = [1, 3] }) {
  const meta = loadMeta(repo);
  const tip = meta.refs["refs/heads/master"];
  // A git client has every ref of the repository, and offers them all as haves
  const others = Object.entries(meta.refs).filter(([name]) => name !== "refs/heads/master").map(([, oid]) => oid);
  await withSession({ blogID: repo, profile }, async (server) => {
    for (const n of behind) {
      const haves = [tipAfterPush(meta, meta.seq - n), ...others];
      for (const phase of ["cold", "warm"]) {
        if (phase === "cold") await server.clearCache();
        const result = await client.fetchFrom(server.gitUrl, [tip], haves);
        const taken = await server.take();
        const facts = taken.facts.filter((f) => f.op === "upload-pack");
        const fact = facts[facts.length - 1] || {};
        record({
          suite: "fetch",
          repo,
          profile,
          phase,
          behindPushes: n,
          ms: result.ms,
          packBytes: result.packBytes,
          objects: result.objects,
          trailerOk: result.trailerOk,
          floor: fact.floor,
          walked: fact.walked,
          packsSent: fact.packsSent,
          packsTotal: fact.packsTotal,
          ...summarise(taken),
        });
      }
    }

    // A client which has only master, so an old branch's tip can only be found
    // by walking history: the walk is bounded, and past the bound the client is
    // sent everything
    if (process.argv.includes("--walk")) {
      const result = await client.fetchFrom(server.gitUrl, [tip], [tipAfterPush(meta, meta.seq - 1)]);
      const taken = await server.take();
      const fact = taken.facts.filter((f) => f.op === "upload-pack").pop() || {};
      record({ suite: "fetch", repo, profile, phase: "cold", behindPushes: "1, only master", ms: result.ms, packBytes: result.packBytes, objects: result.objects, trailerOk: result.trailerOk, floor: fact.floor, walked: fact.walked, packsSent: fact.packsSent, packsTotal: fact.packsTotal, ...summarise(taken) });
    }

    // With a real git client: a repository as it was three pushes ago, then a fetch
    if (repo !== "large") {
      const dest = path.join(WORK, "fetch-" + repo);
      fs.rmSync(dest, { recursive: true, force: true });
      await server.config({ limit: meta.seq - 3 });
      execFileSync("git", ["clone", "--bare", "-q", server.gitUrl, dest], { stdio: "ignore" });
      const before = Number(git(dest, "rev-list", "--count", "--all"));
      await server.config({ limit: null });
      await server.take();
      const started = Date.now();
      const fetched = spawnSync("git", ["--git-dir=" + dest, "fetch", "-q", "origin", "refs/heads/*:refs/heads/*"], { encoding: "utf8" });
      const ms = Date.now() - started;
      const taken = await server.take();
      const fsck = spawnSync("git", ["--git-dir=" + dest, "fsck", "--strict"]);
      const after = Number(git(dest, "rev-list", "--count", "--all"));
      record({ suite: "fetch-git", repo, profile, phase: "real git fetch, 3 pushes behind", ok: fetched.status === 0 && fsck.status === 0 && after === meta.commits.length, commitsBefore: before, commitsAfter: after, ms, ...summarise(taken) });
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
}

// ---- materialize ---------------------------------------------------------

async function materializeSuite({ repo, profile, record, pairs }) {
  await withSession({ blogID: repo, profile }, async (server) => {
    for (const [label, pair] of Object.entries(pairs)) {
      for (const phase of ["cold", "warm"]) {
        if (phase === "cold") await server.clearCache();
        const started = Date.now();
        const out = await server.op("materialize", { old: pair.old, new: pair.new });
        const ms = Date.now() - started;
        const taken = await server.take();
        const same = JSON.stringify([...out.changes].sort()) === JSON.stringify([...pair.lines].sort());
        record({
          suite: "materialize",
          repo,
          profile,
          phase,
          change: label,
          paths: out.count,
          matchesDiffTree: same,
          levels: out.levels,
          treesRead: out.treesRead,
          blobBytes: out.blobBytes,
          treeMs: out.treeMs,
          ms,
          ...summarise(taken),
        });
      }
    }
  });
}

module.exports = { advertisement, cloneSuite, fetchSuite, materializeSuite, loadMeta, tipAfterPush, verifyWithGit, metaPath };
