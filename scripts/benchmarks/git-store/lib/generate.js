// A deterministic generator of synthetic repositories, written straight into
// git packs (with their indexes) rather than through git, so a repository of
// several GB is made in minutes and the same seed always gives the same
// repository byte for byte.
//
// What it makes looks like a blog repository grown to a large size: markdown
// posts under posts/YYYY/MM/, images under images/YYYY/ (random bytes, as a
// compressed JPEG is), a few templates and data files, and one commit per
// step on master. Text files change a little at a time, so they sit in delta
// chains (up to 50 deep, as git's default); directory trees are rewritten
// along the path of every change and are deltas too. There is a second branch
// and a tag.
//
// Packs are made as a real host would hold them: first a few large "base"
// packs (what a clone or a repack leaves; deltas only within a pack), then
// many small "push" packs, one per push. A push pack's deltas can refer to
// objects in older packs (REF_DELTA), and, as `index-pack --fix-thin` does,
// carries a whole copy of each such base at its end, so the same object is in
// two packs and a clone must skip one.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const gitobj = require("./gitobj");

const MAX_DEPTH = 50;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBytes(seed, size) {
  const out = Buffer.allocUnsafe(size + 4);
  let x = (seed | 1) >>> 0;
  for (let i = 0; i < size; i += 4) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out.writeUInt32LE(x, i);
  }
  return out.subarray(0, size);
}

function makeVocabulary(rand) {
  const syllables = ["ka", "lo", "mi", "ra", "te", "su", "no", "vi", "ha", "pe", "do", "ni", "ba", "ze", "to", "ru"];
  const words = [];
  for (let i = 0; i < 2500; i++) {
    const n = 1 + Math.floor(rand() * 4);
    let word = "";
    for (let j = 0; j < n; j++) word += syllables[Math.floor(rand() * syllables.length)];
    words.push(word);
  }
  return words;
}

function generate(spec, { onPack, onHistory, log = () => {} }) {
  const rand = mulberry32(spec.seed);
  const words = makeVocabulary(rand);
  const line = () => {
    const n = 8 + Math.floor(rand() * 10);
    const parts = [];
    for (let i = 0; i < n; i++) parts.push(words[Math.floor(rand() ** 2 * words.length)]);
    return parts.join(" ") + ".";
  };
  const text = (lines) => Array.from({ length: lines }, line).join("\n") + "\n";

  const dirs = new Map();
  function dir(p) {
    if (!dirs.has(p)) dirs.set(p, { path: p, entries: new Map(), obj: null });
    return dirs.get(p);
  }
  dir("");

  const files = new Map();
  const posts = [];
  const seen = new Set();
  const commits = [];
  const commitBodies = [];
  const refs = {};

  let writer;
  let pack;
  let packs = 0;
  let seq = 0;
  let pendingBases = new Map();

  function startPack(kind) {
    packs++;
    const file = path.join(spec.dir, "building-" + packs + ".pack");
    writer = createWriter(file);
    pack = { id: packs, kind, file, firstCommit: commits.length };
    pendingBases = new Map();
  }
  const createWriter = (file) => gitobj.createPackWriter(file);

  // Writes the object `body`, as a delta against `prev` (a record of the
  // previous version) if that is cheaper. Returns the object's ID and the
  // record for the next version.
  function put(prev, type, body, { level = 1, delta = true } = {}) {
    const oid = gitobj.objectId(type, body);
    if (seen.has(oid)) return { oid, record: prev };
    seen.add(oid);

    let offset;
    let depth = 0;
    if (delta && prev && prev.buf && prev.depth < MAX_DEPTH && body.length >= 200) {
      const d = gitobj.makeDelta(prev.buf, body);
      if (d.length < body.length * 0.8) {
        if (prev.pack === pack.id) {
          offset = writer.ofsDelta(oid, prev.offset, d);
        } else if (pack.kind === "push") {
          offset = writer.refDelta(oid, prev.oid, d);
          pendingBases.set(prev.oid, { type, buf: prev.buf });
        }
        if (offset !== undefined) depth = prev.depth + 1;
      }
    }
    if (offset === undefined) offset = writer.whole(type, oid, body, level);
    return { oid, record: { oid, buf: type === "blob" && body.length > 200000 ? null : body, depth, pack: pack.id, offset } };
  }

  async function finishPack(lastCommit) {
    // The bases a push pack's deltas refer to, appended whole
    for (const [oid, base] of pendingBases) writer.whole(base.type, oid, base.buf);
    const info = writer.finish();
    seq++;

    if (commits.length > spec.branchAt && !refs["refs/heads/archive"]) refs["refs/heads/archive"] = commits[spec.branchAt];
    if (commits.length > spec.tagAt && !refs["refs/tags/v1"]) refs["refs/tags/v1"] = commits[spec.tagAt];
    refs["refs/heads/master"] = commits[lastCommit];

    const result = {
      name: info.name,
      size: info.size,
      idxSize: info.idx.length,
      objects: info.objects,
      idx: info.idx,
      file: pack.file,
      seq,
      kind: pack.kind,
      commits: commits.length - pack.firstCommit,
      refs: { ...refs },
    };
    await onPack(result);
    log("pack " + seq + " " + info.name.slice(0, 12) + " " + pack.kind + " " + (info.size / 1048576).toFixed(1) + " MB, " + info.objects + " objects, " + result.commits + " commits");
  }

  // Marks a directory and everything above it as needing its tree rewritten
  function touch(dirPath) {
    for (;;) {
      dir(dirPath).dirty = true;
      if (!dirPath) return;
      const parts = dirPath.split("/");
      const leaf = parts.pop();
      dirPath = parts.join("/");
      const parent = dir(dirPath);
      if (!parent.entries.has(leaf)) parent.entries.set(leaf, { mode: "40000", oid: null });
    }
  }

  function setBlob(p, oid) {
    const parts = p.split("/");
    const name = parts.pop();
    const dirPath = parts.join("/");
    dir(dirPath).entries.set(name, { mode: "100644", oid });
    touch(dirPath);
  }

  function writeFile(p, buf, options) {
    const prior = files.get(p);
    const { oid, record } = put(prior, "blob", buf, options);
    if (record) files.set(p, record);
    setBlob(p, oid);
  }

  function flushTrees() {
    const depth = (d) => (d.path ? d.path.split("/").length : 0);
    const dirty = [...dirs.values()].filter((d) => d.dirty && d.path).sort((a, b) => depth(b) - depth(a));
    for (const d of dirty) {
      const body = gitobj.serializeTree([...d.entries].map(([name, e]) => ({ name, mode: e.mode, oid: e.oid })));
      const { oid, record } = put(d.obj, "tree", body);
      d.obj = record;
      const parts = d.path.split("/");
      const leaf = parts.pop();
      dir(parts.join("/")).entries.get(leaf).oid = oid;
      d.dirty = false;
    }
    const root = dir("");
    const body = gitobj.serializeTree([...root.entries].map(([name, e]) => ({ name, mode: e.mode, oid: e.oid })));
    const { oid, record } = put(root.obj, "tree", body);
    root.obj = record;
    root.dirty = false;
    return oid;
  }

  const YEAR_SECONDS = 365 * 24 * 3600;
  const start = 1451606400; // 2016-01-01
  let imageCount = 0;

  function yearOf(i) {
    return 2016 + Math.floor((i * spec.years) / spec.commits);
  }

  function step(i) {
    const year = yearOf(i);
    const month = String(1 + Math.floor(rand() * 12)).padStart(2, "0");
    const oneFile = spec.oneFile;

    // Which changes this commit makes
    const makeNew = posts.length === 0 || rand() < spec.pNew;
    const addImage = rand() < spec.pImage;
    let edits = oneFile ? 0 : 1 + Math.floor(rand() * 3);
    if (oneFile && !makeNew && !addImage) edits = 1;

    let subject = "Update";
    if (makeNew) {
      const p = "posts/" + year + "/" + month + "/post-" + i + ".md";
      writeFile(p, Buffer.from("# Post " + i + "\n\n" + text(20 + Math.floor(rand() * 120))));
      posts.push(p);
      subject = "Add " + p;
    }
    if (addImage && (!oneFile || !makeNew)) {
      const size = 60000 + Math.floor(rand() ** 2 * spec.imageSpread);
      const p = "images/" + year + "/photo-" + imageCount++ + ".jpg";
      writeFile(p, randomBytes(i * 7919 + 1, size), { level: 0, delta: false });
      subject = "Add " + p;
    }
    for (let e = 0; e < edits; e++) {
      const recent = rand() < 0.6;
      const p = posts[Math.floor((recent ? 1 - rand() ** 2 : rand()) * (posts.length - 1))];
      const lines = files.get(p).buf.toString("utf8").split("\n");
      const at = 2 + Math.floor(rand() * (lines.length - 3));
      const r = rand();
      if (r < 0.6) lines[at] = line();
      else if (r < 0.9) lines.splice(at, 0, line(), line());
      else lines.splice(at, 1);
      writeFile(p, Buffer.from(lines.join("\n")));
      subject = "Edit " + p;
    }
    if (!oneFile && rand() < spec.pTemplate) {
      const p = "templates/layout-" + Math.floor(rand() * 6) + ".html";
      const prior = files.get(p);
      const lines = prior ? prior.buf.toString("utf8").split("\n") : text(400).split("\n");
      lines[Math.floor(rand() * (lines.length - 1))] = line();
      writeFile(p, Buffer.from(lines.join("\n")));
    }

    const tree = flushTrees();
    const parents = commits.length ? [commits[commits.length - 1]] : [];
    const body = gitobj.serializeCommit({ tree, parents, time: start + Math.floor((i * spec.years * YEAR_SECONDS) / spec.commits), message: subject });
    const oid = gitobj.objectId("commit", body);
    seen.add(oid);
    writer.whole("commit", oid, body);
    commits.push(oid);
    if (onHistory) commitBodies.push(body);
  }

  return (async () => {
    let i = 0;
    const pushSizes = spec.pushSizes(rand);
    let pushIndex = 0;
    let pushLeft = 0;
    startPack(spec.baseCommits > 0 ? "base" : "push");
    if (spec.baseCommits === 0) pushLeft = pushSizes[pushIndex++] || spec.commits;

    while (i < spec.commits) {
      step(i);
      i++;

      if (i <= spec.baseCommits) {
        if (writer.size >= spec.packLimit || i === spec.baseCommits) {
          await finishPack(i - 1);
          if (i < spec.commits) startPack(i < spec.baseCommits ? "base" : "push");
          if (i === spec.baseCommits) pushLeft = pushSizes[pushIndex++] || spec.commits;
        }
      } else if (--pushLeft <= 0 || i === spec.commits) {
        await finishPack(i - 1);
        if (i < spec.commits) {
          startPack("push");
          pushLeft = pushSizes[pushIndex++] || spec.commits;
        }
      }
    }

    // The history pack: every commit, whole, in one pack
    let history = null;
    if (onHistory) {
      const file = path.join(spec.dir, "building-history.pack");
      const historyWriter = createWriter(file);
      commitBodies.forEach((body, n) => historyWriter.whole("commit", commits[n], body));
      const info = historyWriter.finish();
      history = { name: info.name, size: info.size, idxSize: info.idx.length, objects: info.objects, idx: info.idx, file, through: seq };
      await onHistory(history);
    }

    return { commits, refs, packs: seq, files: files.size, images: imageCount, history };
  })();
}

// The shapes the spike uses
const SPECS = {
  // Larger than the 1 GB cache by a clear margin, sized to fit this machine
  large: {
    seed: 2259,
    commits: 40000,
    baseCommits: 34000,
    years: 10,
    pNew: 0.25,
    pImage: 0.16,
    pTemplate: 0.15,
    imageSpread: 900000,
    packLimit: 650 * 1024 * 1024,
    branchAt: 1000,
    tagAt: 100,
    oneFile: false,
    pushSizes: (rand) => Array.from({ length: 80 }, () => 20 + Math.floor(rand() ** 2 * 400)),
  },
  // A typical blog: mostly markdown and images, a few thousand commits, each
  // changing one file as Blot's own commits do. One pack per commit, as the
  // store writes them before any compaction.
  blogUncompacted: {
    seed: 7,
    commits: 3000,
    baseCommits: 0,
    years: 8,
    pNew: 0.3,
    pImage: 0.12,
    pTemplate: 0,
    imageSpread: 500000,
    packLimit: Infinity,
    branchAt: 100000,
    tagAt: 100000,
    oneFile: true,
    pushSizes: () => Array.from({ length: 3000 }, () => 1),
  },
  // The same history after compaction: one base pack and a tail of pushes
  blog: {
    seed: 7,
    commits: 3000,
    baseCommits: 2900,
    years: 8,
    pNew: 0.3,
    pImage: 0.12,
    pTemplate: 0,
    imageSpread: 500000,
    packLimit: Infinity,
    branchAt: 100000,
    tagAt: 100000,
    oneFile: true,
    pushSizes: () => Array.from({ length: 100 }, () => 1),
  },
  // Small, for specs of the harness itself
  tiny: {
    seed: 1,
    commits: 120,
    baseCommits: 80,
    years: 2,
    pNew: 0.3,
    pImage: 0.1,
    pTemplate: 0.1,
    imageSpread: 40000,
    packLimit: 100 * 1024,
    branchAt: 20,
    tagAt: 10,
    oneFile: false,
    pushSizes: (rand) => Array.from({ length: 20 }, () => 2 + Math.floor(rand() * 6)),
  },
};

module.exports = { generate, SPECS, mulberry32, randomBytes };
