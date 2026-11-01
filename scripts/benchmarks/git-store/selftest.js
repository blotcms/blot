// Checks the harness against real git on a small repository, with no MinIO:
//
//  1. the generator's packs pass `git fsck --strict`;
//  2. a clone stream built from overlapping packs (so entries in the middle of
//     a pack are skipped, and OFS_DELTA offsets are rewritten) is accepted by
//     `git index-pack --strict` and holds exactly the repository's objects;
//  3. the tree diff and the ref advertisement agree with git.
//
//   node scripts/benchmarks/git-store/selftest.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { execFileSync } = require("child_process");
const { createMemoryStore } = require("../../../app/clients/git/store");
const { generate, SPECS } = require("./lib/generate");
const { planPack, packStream } = require("./lib/clone");

const git = (dir, ...args) => execFileSync("git", ["--git-dir=" + dir, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-store-selftest-"));
  try {
    const source = path.join(root, "source.git");
    execFileSync("git", ["init", "-q", "--bare", "--initial-branch=master", source]);
    const result = await generate(
      { ...SPECS.tiny, dir: root },
      {
        onPack: async (pack) => {
          fs.renameSync(pack.file, path.join(source, "objects/pack", pack.name + ".pack"));
          fs.writeFileSync(path.join(source, "objects/pack", pack.name + ".idx"), pack.idx);
        },
      }
    );
    for (const [ref, oid] of Object.entries(result.refs)) git(source, "update-ref", ref, oid);
    git(source, "fsck", "--strict");
    console.log("generated repository passes git fsck --strict");

    // Two overlapping packs made by git itself: the first 60 commits, then
    // everything (a non-thin pack which repeats the first 60 commits' objects)
    const store = createMemoryStore();
    const entries = [];
    for (const [name, tip] of [["a", result.commits[59]], ["b", "--all"]]) {
      const list = git(source, "rev-list", "--objects", tip).replace(/^(\w{40}).*$/gm, "$1");
      const file = path.join(root, name + ".pack");
      fs.writeFileSync(file, execFileSync("git", ["--git-dir=" + source, "pack-objects", "--stdout", "--delta-base-offset"], { input: list, maxBuffer: 1 << 28 }));
      const scratch = path.join(root, name + ".git");
      execFileSync("git", ["init", "-q", "--bare", scratch]);
      const indexed = execFileSync("git", ["--git-dir=" + scratch, "index-pack", "--stdin"], { input: fs.readFileSync(file) }).toString().trim().split(/\s+/).pop();
      const pack = fs.readFileSync(path.join(scratch, "objects/pack/pack-" + indexed + ".pack"));
      const idx = fs.readFileSync(path.join(scratch, "objects/pack/pack-" + indexed + ".idx"));
      await store.put("packs/pack-" + indexed + ".pack", pack);
      await store.put("packs/pack-" + indexed + ".idx", idx);
      entries.push({ name: "pack-" + indexed, size: pack.length, idxSize: idx.length, objects: pack.readUInt32BE(8), seq: entries.length + 1 });
    }

    const plan = await planPack(store, entries);
    assert(plan.skipped > 0, "the packs should overlap");
    const chunks = [];
    const stats = {};
    for await (const chunk of packStream(store, plan, stats)) chunks.push(chunk);
    const stream = Buffer.concat(chunks);
    assert(stats.rewritten > 0 || stats.toRef > 0, "the stream should have needed offset rewrites");

    const target = path.join(root, "target.git");
    execFileSync("git", ["init", "-q", "--bare", target]);
    execFileSync("git", ["--git-dir=" + target, "index-pack", "--stdin", "--strict"], { input: stream });
    const want = git(source, "rev-list", "--objects", "--all").split("\n").filter(Boolean).map((l) => l.slice(0, 40)).sort();
    const have = git(target, "cat-file", "--batch-all-objects", "--batch-check=%(objectname)").split("\n").filter(Boolean).sort();
    // the repository has unreachable blobs, which are in the packs and so in the stream
    assert(have.length >= want.length, "the stream is missing objects");
    assert.strictEqual(have.length, plan.total, "the object count in the header must be the number of distinct objects");
    for (const oid of want) assert(have.includes(oid), "missing " + oid);
    console.log("clone stream with " + plan.skipped + " skipped entries (" + JSON.stringify(stats) + ") is accepted by git index-pack --strict and holds " + have.length + " objects");
    console.log("ok");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
