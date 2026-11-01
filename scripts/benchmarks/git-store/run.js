// The git store spike's driver. See README.md.
//
//   node scripts/benchmarks/git-store/run.js generate <large|blog|blogUncompacted> [blogID]
//   node scripts/benchmarks/git-store/run.js reads <repo> [--profiles a,b] [--verify]
//   node scripts/benchmarks/git-store/run.js refs <repo>
//   ... see README.md for the rest
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { PROFILES, WORK } = require("./lib/session");
const { generateAndUpload } = require("./lib/upload");
const reads = require("./lib/readsuites");
const writes = require("./lib/writesuites");
const { startServer } = require("./lib/harness");

const RESULTS = process.env.GIT_STORE_SPIKE_RESULTS || path.join(WORK, "results.jsonl");

function record(row) {
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
  fs.appendFileSync(RESULTS, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n");
  const { suite, repo, profile, phase, ms, requests, bytesIn, rssPeakMB, change } = row;
  console.log([suite, repo, profile, phase, change, ms && Math.round(ms) + "ms", requests + " req", bytesIn && Math.round(bytesIn / 1024) + " KB in", rssPeakMB && rssPeakMB + " MB rss"].filter((x) => x !== undefined && x !== null && x !== "").join("  "));
}

function arg(name, fallback) {
  const at = process.argv.indexOf("--" + name);
  return at >= 0 ? process.argv[at + 1] : fallback;
}

const profilesToRun = () => (arg("profiles") ? arg("profiles").split(",") : PROFILES);

// diff-tree references for a repository, from a real clone, for the
// materialize comparison
async function buildRefs(repo) {
  const meta = reads.loadMeta(repo);
  const server = await startServer({ blogID: repo, via: "direct", cacheDir: path.join(WORK, "cache-refs-" + repo) });
  const scratch = path.join(WORK, "refs-" + repo);
  fs.rmSync(scratch, { recursive: true, force: true });
  execFileSync("git", ["clone", "--bare", "-q", server.gitUrl, scratch]);
  await server.stop();
  const n = meta.commits.length;
  const out = {};
  for (const [label, back] of [["small", 1], ["medium", Math.min(100, n - 1)], ["large", Math.min(1000, n - 1)]]) {
    const old = meta.commits[n - 1 - back];
    const target = meta.commits[n - 1];
    const text = execFileSync("git", ["--git-dir=" + scratch, "diff-tree", "-r", "--no-renames", "--name-status", old, target], { encoding: "utf8", maxBuffer: 1 << 28 });
    out[label] = { old, new: target, lines: text.split("\n").filter(Boolean).map((l) => l.replace("\t", " ")).sort() };
  }
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.writeFileSync(path.join(WORK, "meta", "ref-" + repo + ".json"), JSON.stringify(out));
  return out;
}

async function main() {
  const [command, repo, third] = process.argv.slice(2);

  if (command === "generate") {
    const blogID = third || repo;
    const meta = await generateAndUpload({
      specName: repo,
      blogID,
      workDir: path.join(WORK, "build-" + blogID),
      metaFile: reads.metaPath(blogID),
      log: (m) => console.log(m),
    });
    const { commits, packs, ...rest } = meta;
    console.log(JSON.stringify({ ...rest, packCount: packs.length, commitCount: commits.length }, null, 1));
    return;
  }

  if (command === "refs") {
    await buildRefs(repo);
    return;
  }

  if (command === "reads") {
    const refsFile = path.join(WORK, "meta", "ref-" + repo + ".json");
    if (!fs.existsSync(refsFile)) await buildRefs(repo);
    const allPairs = JSON.parse(fs.readFileSync(refsFile, "utf8"));
    const pairs = Object.fromEntries(Object.entries(allPairs).filter(([label]) => !arg("pairs") || arg("pairs").split(",").includes(label)));
    const only = arg("only");
    for (const profile of profilesToRun()) {
      if (!only || only.includes("advertise")) await reads.advertisement({ repo, profile, record });
      if (!only || only.includes("clone")) await reads.cloneSuite({ repo, profile, record, verify: process.argv.includes("--verify") });
      if (!only || only.includes("fetch")) await reads.fetchSuite({ repo, profile, record });
      if (!only || only.includes("materialize")) await reads.materializeSuite({ repo, profile, record, pairs });
    }
    return;
  }

  if (command === "push" || command === "commit") {
    for (const profile of profilesToRun()) {
      if (command === "push") await writes.pushSuite({ repo, profile, record });
      else await writes.commitSuite({ repo, profile, record });
    }
    return;
  }

  if (command === "history") {
    for (const profile of profilesToRun()) await require("./lib/history").historySuite({ repo, profile, record });
    return;
  }

  if (command === "growth") {
    for (const row of require("./lib/growth").growth()) record({ suite: "growth", ...row });
    return;
  }

  if (command === "failure") {
    const failure = require("./lib/failure");
    if (repo) await failure[repo]({ record });
    else await failure.failureSuite({ record });
    return;
  }

  if (command === "index") {
    const idx = require("./lib/idxbench");
    const shapes = [{ packs: 1, perPack: 10_000_000 }, { packs: 40, perPack: 250_000 }];
    for (const shape of shapes) {
      for (const profile of profilesToRun()) await idx.idxSuite({ profile, record, ...shape });
      await idx.cleanup("idx-" + shape.packs + "x" + shape.perPack);
    }
    // a cache too small for 10M objects' index buckets
    await idx.idxSuite({ profile: "s3-standard", record, packs: 1, perPack: 10_000_000, cacheBytes: 64 * 1024 * 1024, label: "idx-1x10000000 (64 MB cache)" });
    await idx.cleanup("idx-1x10000000");
    return;
  }

  if (command === "commit300") {
    for (const profile of profilesToRun()) await writes.commit300({ profile, record });
    return;
  }

  throw new Error("Unknown command " + command);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
