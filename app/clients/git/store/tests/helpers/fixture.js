// Real repositories for the store's specs, made with the real `git` binary,
// and the oracle to check the store against: `git cat-file` on the same
// objects. Not a spec itself.
//
// buildFixture() makes a repository whose history gives git something to
// delta: a text file edited a little at a time, small binary files, a tag, and
// one large incompressible file for reads which take many round trips.
const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

// Runs git in `cwd`; returns stdout as a Buffer. Throws with git's stderr.
function git(cwd, args, input) {
  const result = spawnSync("git", args, { cwd, env: ENV, input, maxBuffer: 1 << 30 });
  if (result.status !== 0) {
    throw new Error("git " + args.join(" ") + " failed: " + result.stderr.toString());
  }
  return result.stdout;
}

const text = (cwd, args, input) => git(cwd, args, input).toString().trim();

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "git-store-spec-"));
}

// A small deterministic generator, so a fixture is the same every run
function random(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function bytes(seed, length) {
  const next = random(seed);
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = next() >>> 24;
  return out;
}

function lines(version) {
  const next = random(7);
  const out = [];
  for (let i = 0; i < 400; i++) {
    const n = next() % 1000;
    out.push("line " + i + " " + (i % 40 === version % 40 ? "edited " + version : "same") + " " + n);
  }
  return out.join("\n") + "\n";
}

// Makes a repository in `dir` with `commits` commits. Returns { dir, commits,
// head, tag } where commits are the commit IDs oldest first.
function buildFixture(dir, { commits = 30, large = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "master"]);

  const ids = [];
  const binary = bytes(1, 64 * 1024);

  for (let i = 1; i <= commits; i++) {
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    fs.mkdirSync(path.join(dir, "posts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "docs", "big.txt"), lines(i));
    fs.writeFileSync(path.join(dir, "posts", "post-" + i + ".txt"), "Post number " + i + "\n" + lines(i % 3).slice(0, 4000));
    binary[(i * 997) % binary.length] ^= 0xff;
    fs.writeFileSync(path.join(dir, "data.bin"), binary);
    if (large && i === 10) fs.writeFileSync(path.join(dir, "large.bin"), bytes(2, 3 * 1024 * 1024));
    if (i === 15) fs.writeFileSync(path.join(dir, "empty.txt"), "");

    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", "Commit " + i]);
    ids.push(text(dir, ["rev-parse", "HEAD"]));
  }

  git(dir, ["tag", "-a", "v1", "-m", "Version 1", ids[ids.length - 1]]);

  return {
    dir,
    commits: ids,
    head: ids[ids.length - 1],
    tag: text(dir, ["rev-parse", "v1"]),
  };
}

// Packs all of a repository's objects into one pack (git's usual repack, deep
// deltas on), or with `refDeltas`, with deltas which name their base by ID
function repackAll(dir, { refDeltas = false } = {}) {
  const args = ["repack", "-adfq", "--window=100", "--depth=50"];
  if (refDeltas) args.unshift("-c", "repack.useDeltaBaseOffset=false");
  git(dir, args);
}

// Every pack in the repository as { name, pack, idx } (Buffers)
function readPacks(dir) {
  const packDir = path.join(dir, ".git", "objects", "pack");
  return fs
    .readdirSync(packDir)
    .filter((file) => file.endsWith(".pack"))
    .map((file) => {
      const name = file.slice(0, -".pack".length);
      return {
        name,
        pack: fs.readFileSync(path.join(packDir, file)),
        idx: fs.readFileSync(path.join(packDir, name + ".idx")),
      };
    });
}

// The objects reachable from `include` and not from `exclude`, as a pack
// (self-contained unless `thin`, when deltas may name objects it leaves out).
// Returns the pack's bytes; a complete one is indexed by indexPack, a thin one
// by fixThin.
function packRevs(dir, include, exclude = [], { thin = false } = {}) {
  const input = [...include, ...exclude.map((id) => "^" + id)].join("\n") + "\n";
  const args = ["pack-objects", "--revs", "--stdout", "-q", "--window=100", "--depth=50"];
  if (thin) args.push("--thin");
  return git(dir, args, input);
}

function packName(pack) {
  return "pack-" + pack.subarray(pack.length - 20).toString("hex");
}

// Indexes a complete pack file with git, returning { name, pack, idx }
function indexPack(pack) {
  const dir = tempDir();
  try {
    const file = path.join(dir, "in.pack");
    fs.writeFileSync(file, pack);
    git(dir, ["index-pack", file]);
    return { name: packName(pack), pack, idx: fs.readFileSync(path.join(dir, "in.idx")) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Completes a thin pack the way a push does: `git index-pack --fix-thin` in a
// repository which has `bases` (packs with what the thin pack's deltas name).
// The result has the base objects appended, so it repeats objects the bases
// already hold.
function fixThin(thin, bases) {
  const dir = tempDir();
  try {
    git(dir, ["init", "-q", "--bare"]);
    const packDir = path.join(dir, "objects", "pack");
    for (const base of bases) {
      fs.writeFileSync(path.join(packDir, base.name + ".pack"), base.pack);
      fs.writeFileSync(path.join(packDir, base.name + ".idx"), base.idx);
    }
    const out = text(dir, ["index-pack", "--stdin", "--fix-thin"], thin);
    const name = "pack-" + out.split(/\s+/).pop();
    return {
      name,
      pack: fs.readFileSync(path.join(packDir, name + ".pack")),
      idx: fs.readFileSync(path.join(packDir, name + ".idx")),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// [{ oid, type, size, offset }] for a pack, sorted by offset, from git
function listEntries({ pack, idx }) {
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "x.pack"), pack);
    fs.writeFileSync(path.join(dir, "x.idx"), idx);
    const out = text(dir, ["verify-pack", "-v", path.join(dir, "x.pack")]);
    return out
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((f) => /^[0-9a-f]{40}$/.test(f[0]) && f.length >= 5)
      .map((f) => ({ oid: f[0], type: f[1], size: +f[2], offset: +f[4], depth: f[5] ? +f[5] : 0 }))
      .sort((a, b) => a.offset - b.offset);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The thin pack inside a fixed one: the fixed pack's first `count` entries,
// which are the thin pack's own, with a count and checksum to match. Its
// deltas name bases which are not in the pack: they are in the packs it was
// fixed against. It needs an index git would not write, hence buildIdx.
function cutThin(fixed, count) {
  const entries = listEntries(fixed);
  const cut = count < entries.length ? entries[count].offset : fixed.pack.length - 20;
  const body = Buffer.from(fixed.pack.subarray(0, cut));
  body.writeUInt32BE(count, 8);
  const pack = Buffer.concat([body, crypto.createHash("sha1").update(body).digest()]);
  const kept = entries.slice(0, count);
  return { name: packName(pack), pack, idx: buildIdx(kept, pack), entries: kept };
}

// A version 2 index for a pack, from [{ oid, offset }]. Offsets at or over
// `largeFrom` go in the table of 8-byte offsets, as they would in a pack over
// 2 GB, so that table can be tested without making one.
function buildIdx(entries, pack, { largeFrom = 2 ** 31 } = {}) {
  const sorted = [...entries].sort((a, b) => a.oid.localeCompare(b.oid));
  const fanout = Buffer.alloc(256 * 4);
  for (const e of sorted) {
    for (let b = parseInt(e.oid.slice(0, 2), 16); b < 256; b++) {
      fanout.writeUInt32BE(fanout.readUInt32BE(b * 4) + 1, b * 4);
    }
  }

  const ids = Buffer.concat(sorted.map((e) => Buffer.from(e.oid, "hex")));
  const crcs = Buffer.alloc(sorted.length * 4);
  const offsets = Buffer.alloc(sorted.length * 4);
  const large = [];
  sorted.forEach((e, i) => {
    if (e.offset >= largeFrom) {
      offsets.writeUInt32BE((0x80000000 | large.length) >>> 0, i * 4);
      const eight = Buffer.alloc(8);
      eight.writeBigUInt64BE(BigInt(e.offset));
      large.push(eight);
    } else {
      offsets.writeUInt32BE(e.offset, i * 4);
    }
  });

  const header = Buffer.from([0xff, 0x74, 0x4f, 0x63, 0, 0, 0, 2]);
  const body = Buffer.concat([header, fanout, ids, crcs, offsets, ...large, pack.subarray(pack.length - 20)]);
  return Buffer.concat([body, crypto.createHash("sha1").update(body).digest()]);
}

// Every object in the repository as Map(oid -> { type, data }), read by git
function catAll(dir, oids) {
  const list =
    oids ||
    text(dir, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])
      .split("\n")
      .filter(Boolean);
  const out = git(dir, ["cat-file", "--batch"], list.join("\n") + "\n");

  const objects = new Map();
  let at = 0;
  while (at < out.length) {
    const eol = out.indexOf(10, at);
    const [oid, type, size] = out.toString("latin1", at, eol).split(" ");
    objects.set(oid, { type, data: out.subarray(eol + 1, eol + 1 + +size) });
    at = eol + 1 + +size + 1;
  }
  return objects;
}

// Puts a pack in an object store as the repository's store would hold it,
// and returns its manifest entry
async function upload(store, { name, pack, idx }, objects) {
  await store.put("packs/" + name + ".pack", pack);
  await store.put("packs/" + name + ".idx", idx);
  return { name, size: pack.length, idxSize: idx.length, objects };
}

function remove(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  git,
  text,
  tempDir,
  remove,
  bytes,
  buildFixture,
  repackAll,
  readPacks,
  packRevs,
  packName,
  indexPack,
  fixThin,
  listEntries,
  cutThin,
  buildIdx,
  catAll,
  upload,
};
