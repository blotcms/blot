// The git store's upkeep in shadow mode (see ./index.js and #2259), run once a
// day by the scheduler (app/scheduler/git-store-maintenance.js), and by hand
// with scripts/git/verify-store.js and scripts/git/backfill-store.js:
//
//   gitBlogs({ all, ids })    the blogs on the git client which are shadowed
//                             (BLOT_GIT_STORE_SHADOW), or every one with `all`
//   sweepBlog(blogID)         the store's sweep(), with its defaults
//   verify(blogID, options)   compares the blog's EBS repository with its store
//   orphans(options)          deletes <blogID>/git/ prefixes left behind by
//                             blogs no longer on git
//   daily(options)            all of the above, for every shadowed blog; the
//                             orphans only on the first of the month
//
// The verifier has two checks:
//
//   cheap  the branches and tags are the same on both sides (and the store's
//          peeled tags are what EBS peels them to), and every file the newest
//          manifest names is in the bucket, at the size it says: each pack's
//          .pack, .idx and .rev, and the history pack's and pieces' .pack and
//          .idx (they have no .rev). One manifest read and a HEAD a file.
//   deep   a clone of the store through its own clone code, into scratch,
//          index-pack --strict, fsck --strict, and every branch, tag, HEAD and
//          peeled tag compared with EBS (the store's verifyImport).
//
// A push in flight can make the two sides differ for a moment, so a check
// which finds anything is run once more after a short delay, and only what
// that finds counts. Each finding is logged in shadow mode's format:
//
//   [git-store-shadow] blog=<id> op=verify outcome=ok|mismatch|missing|error
//     check=cheap|deep ... detail=...
//
// Nothing here modifies an EBS repository. Blog handles stay out of the logs.
const path = require("path");
const config = require("config");
const Blog = require("models/blog");
const hook = require("./hook");
const shadow = require("./index");
const { manifest, layout } = require("../store");
const sweep = require("../store/sweep");
const { verifyImport } = require("../store/import");
const { measure } = require("./counting");

const DAY = 24 * 60 * 60 * 1000;

// How many blogs a day get the deep check, besides the git test blog. The
// sample moves on each day, so every shadowed blog is cloned in turn.
const DEEP_SAMPLE = 5;

// The handle of the production test blog for the git client, which is deep
// checked every day if it is shadowed
const TEST_HANDLE = "gittest";

// How long to wait before checking a blog again, when the first check found
// something: long enough for a push in flight, and its mirror, to land
const RECHECK_DELAY_MS = 60 * 1000;

// A prefix left by a blog off git is only deleted once nothing has been
// written to it for this long, so a reconnect in flight is not touched
const ORPHAN_MIN_AGE_MS = DAY;

// HEADs at once for one blog, and blogs checked at once
const HEADS_AT_ONCE = 8;
const BLOGS_AT_ONCE = 4;
const DELETES_AT_ONCE = 16;

const BLOG_ID = /^blog_[0-9A-Za-z]+$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs fn on each item, `limit` at a time, in order of starting
async function each(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function getBlog(by) {
  return new Promise((resolve, reject) => Blog.get(by, (err, blog) => (err ? reject(err) : resolve(blog || null))));
}

function allBlogIDs() {
  return new Promise((resolve, reject) => Blog.getAllIDs((err, ids) => (err ? reject(err) : resolve(ids || []))));
}

// Where an import or a deep check builds what it needs: the directory the
// shadow cache lives in, on the host's instance store in production (tmp),
// which has far more room than the cache's budget
function defaultScratchDir() {
  return path.dirname(config.git_store.cache_directory);
}

// Whether shadow mode is set up, so there is anything to look after
function configured() {
  return !!String((config.git_store && config.git_store.shadow) || "").trim() && shadow.hasStore();
}

// ---- Which blogs ----------------------------------------------------------

// The IDs of the blogs on the git client, sorted: those shadow mode is on
// for, or with `all` every one. `ids` limits them to those blogs. There is no
// index of blogs by client, so a setting of "all" (or `all`) walks every blog.
async function gitBlogs({ all = false, ids = null } = {}) {
  const setting = String((config.git_store && config.git_store.shadow) || "").trim();
  let candidates = ids;

  if (!candidates) {
    if (!all && setting !== "all") candidates = setting.split(",").map((id) => id.trim()).filter(Boolean);
    else candidates = await allBlogIDs();
  }

  const found = [];

  await each([...new Set(candidates)], 16, async (blogID) => {
    if (!all && !hook.enabled(blogID)) return;
    const blog = await getBlog({ id: blogID });
    if (blog && blog.client === "git") found.push(blogID);
  });

  return found.sort();
}

// ---- The sweep ------------------------------------------------------------

async function sweepBlog(blogID) {
  const ctx = await shadow.contextFor(blogID);
  if (!ctx) return null;

  try {
    const measured = await measure(() => sweep({ store: ctx.store }));
    const stats = measured.result;

    shadow.log({
      blog: blogID,
      op: "sweep",
      outcome: "ok",
      storeMs: measured.ms,
      requests: measured.counts.requests,
      bytesDown: measured.counts.bytesDown,
      manifestsDeleted: stats.manifestsDeleted,
      packsMarked: stats.packsMarked,
      packsDeleted: stats.packsDeleted,
      packsSpared: stats.packsSpared || undefined,
      pending: stats.pending,
      bytesFreed: stats.bytesFreed,
    });

    return stats;
  } catch (err) {
    shadow.log({ blog: blogID, op: "sweep", outcome: "error", detail: shadow.scrub(err, ctx) });
    return { error: shadow.scrub(err, ctx) };
  }
}

// ---- The verifier ---------------------------------------------------------

// The files the manifest names, with the size each should be
function expectedFiles(current) {
  const files = [];

  for (const pack of current.packs) {
    files.push({ key: layout.packKey(pack.name), size: pack.size });
    files.push({ key: layout.idxKey(pack.name), size: pack.idxSize });
    files.push({ key: layout.revKey(pack.name) });
  }

  for (const pack of [current.history, ...(current.historyPieces || [])].filter(Boolean)) {
    files.push({ key: layout.packKey(pack.name), size: pack.size });
    files.push({ key: layout.idxKey(pack.name), size: pack.idxSize });
  }

  // A pack named twice (a history pack also live, say) is looked at once
  const seen = new Set();
  return files.filter((file) => !seen.has(file.key) && seen.add(file.key));
}

// What EBS peels each tag to, as { oid: target }
async function peel(gitDir, oids) {
  if (!oids.length) return {};
  const output = await shadow.git(gitDir, ["cat-file", "--batch-check=%(objectname)"], oids.map((oid) => oid + "^{}").join("\n") + "\n");
  const lines = output.stdout.split("\n");
  return Object.fromEntries(oids.map((oid, i) => [oid, lines[i]]));
}

// The cheap check: { findings, refs, files }
async function cheapCheck(ctx) {
  const { gitDir, store } = ctx;
  const findings = [];
  const ebs = await shadow.ebsRefs(gitDir);
  const current = await manifest.read(store);

  if (current.seq === 0) {
    if (Object.keys(ebs).length) findings.push({ kind: "mismatch", detail: "the store is empty; EBS has " + Object.keys(ebs).length + " refs" });
    return { findings, refs: 0, files: 0 };
  }

  const differ = [];
  for (const ref of [...new Set([...Object.keys(ebs), ...Object.keys(current.refs)])].sort()) {
    if (ebs[ref] !== current.refs[ref]) differ.push(ref + " store " + (current.refs[ref] || "none") + " EBS " + (ebs[ref] || "none"));
  }
  if (differ.length) findings.push({ kind: "mismatch", detail: "refs differ: " + differ.join(", ") });

  const peeled = current.peeled || {};
  const tags = [...new Set(Object.values(current.refs))].filter((oid) => peeled[oid]);
  const ebsPeeled = await peel(gitDir, tags);
  const wrong = tags.filter((oid) => ebsPeeled[oid] !== peeled[oid]);
  if (wrong.length) findings.push({ kind: "mismatch", detail: "peeled tags differ: " + wrong.map((oid) => oid + " store " + peeled[oid] + " EBS " + ebsPeeled[oid]).join(", ") });

  const files = expectedFiles(current);

  await each(files, HEADS_AT_ONCE, async (file) => {
    const found = await store.head(file.key);
    if (!found) findings.push({ kind: "missing", detail: file.key + " (named by manifest " + current.seq + ")" });
    else if (file.size !== undefined && found.size !== file.size) findings.push({ kind: "mismatch", detail: file.key + " is " + found.size + " bytes; manifest " + current.seq + " says " + file.size });
  });

  return { findings, refs: Object.keys(current.refs).length, files: files.length, seq: current.seq };
}

// What git says when the machine, not the cloned bytes, is the problem
const LOCAL_TROUBLE = /No space left on device|Permission denied|Too many open files|Read-only file system|Disk quota exceeded|Cannot allocate memory/i;

// The verdict a deep check's failure is about the store: "missing" for a
// file the store does not have, "mismatch" for bytes or refs that are wrong
// (the store's CorruptError, which verifyImport also throws when refs, HEAD
// or a peeled tag differ, or index-pack or fsck failing on the clone). Null
// for anything else (scratch space, the filesystem, the network, the cache's
// room): an error in checking, which says nothing about the store.
function verdict(err) {
  if (!err) return null;
  if (err.code === "NOT_FOUND") return "missing";
  if (err.code === "CORRUPT") return "mismatch";

  const message = String(err.message || "");
  if (!err.code && /^git (index-pack|fsck)\b/.test(message) && !LOCAL_TROUBLE.test(message)) return "mismatch";

  return null;
}

// The deep check. A verdict on the store is a finding; any other failure is
// thrown, so twice() counts it as an error.
async function deepCheck(ctx, scratchDir) {
  const { gitDir, store, cache } = ctx;

  try {
    // Background work for the git limiter, like the rest of shadow mode, with
    // its waits on the lane clock (waitMs, and left out of storeMs)
    const result = await verifyImport({ store, cache, gitDir, scratchDir, gate: shadow.gate });
    return { findings: [], refs: result.refs, objects: result.objects };
  } catch (err) {
    const kind = verdict(err);
    if (!kind) throw err;
    return { findings: [{ kind, detail: shadow.scrub(err, ctx) }] };
  }
}

// Runs a check, and once more after a delay if it found anything; a check
// which throws is an "error" finding
async function twice(ctx, check, recheckDelayMs) {
  let result;

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 2) await sleep(recheckDelayMs);

    try {
      result = await measure(check);
      result.attempts = attempt;
      if (!result.result.findings.length) return result;
    } catch (err) {
      result = { result: { findings: [{ kind: "error", detail: shadow.scrub(err, ctx) }] }, attempts: attempt, ms: 0, counts: {} };
    }
  }

  return result;
}

// Logs a check's result, one line for each finding, and returns the findings
// as { blog, check, kind, detail }
function report(blogID, check, measured) {
  const { findings, ...rest } = measured.result;
  const fields = {
    blog: blogID,
    op: "verify",
    storeMs: measured.ms,
    requests: measured.counts.requests,
    bytesDown: measured.counts.bytesDown,
    waitMs: measured.counts.waitMs,
    check,
    attempts: measured.attempts > 1 ? measured.attempts : undefined,
    seq: rest.seq,
    refs: rest.refs,
    files: rest.files,
    objects: rest.objects,
  };

  if (!findings.length) shadow.log({ ...fields, outcome: "ok" });
  for (const finding of findings) shadow.log({ ...fields, outcome: finding.kind, detail: finding.detail });

  return findings.map((finding) => ({ blog: blogID, check, ...finding }));
}

// Checks one blog: the cheap check, and with `deep` the deep one too (only if
// the cheap one passed; `cheap: false` skips it, for a blog which has just
// had it). Resolves with { blog, skipped, deep, findings }; never rejects for
// a failure of the check itself, which is an "error" finding.
async function verify(blogID, { deep = false, cheap = true, scratchDir = defaultScratchDir(), recheckDelayMs = RECHECK_DELAY_MS } = {}) {
  const ctx = await shadow.contextFor(blogID);

  if (!ctx) {
    shadow.log({ blog: blogID, op: "verify", outcome: "skipped", detail: "the blog is gone, off git or has no repository" });
    return { blog: blogID, skipped: true, deep: false, findings: [] };
  }

  if (cheap) {
    const found = report(blogID, "cheap", await twice(ctx, () => cheapCheck(ctx), recheckDelayMs));
    if (found.length || !deep) return { blog: blogID, findings: found, deep: false };
  }

  const deepFindings = report(blogID, "deep", await twice(ctx, () => deepCheck(ctx, scratchDir), recheckDelayMs));
  return { blog: blogID, findings: deepFindings, deep: true };
}

// The blogs for today's deep check: `count` of them, moving on through the
// sorted list one window a day, so each is checked in turn
function deepSample(ids, count, now) {
  if (ids.length <= count) return ids.slice();
  const start = (Math.floor(now / DAY) * count) % ids.length;
  return Array.from({ length: count }, (_, i) => ids[(start + i) % ids.length]);
}

// ---- Prefixes left behind -------------------------------------------------

// The blog IDs with anything under <blogID>/git/ in the bucket: one listing
// of the bucket's top level, then one short listing a blog. Specs replace it.
async function* s3Prefixes() {
  const s3 = require("storage/s3");
  for await (const entry of s3.listEntries("", "/")) {
    if (!entry.prefix) continue;
    const blogID = entry.prefix.replace(/\/$/, "");
    if (!BLOG_ID.test(blogID)) continue;
    for await (const object of s3.listEntries(blogID + "/git/")) {
      if (object.key) yield blogID;
      break;
    }
  }
}

let listPrefixes = s3Prefixes;

// Deletes <blogID>/git/ for each blog which no longer exists, or is no longer
// on git, once nothing has been written to it for minAge: what an operation
// in another process left after the disconnect's two passes (see removeBlog
// in ./index.js), or a disconnect cut off by a restart. A blog on git is never
// touched, and is looked up again just before the delete. Only the keys listed
// are deleted, so anything written after the listing is left. Resolves with
// counts, and `findings` for the alert email: a kind "orphan" finding for each
// prefix deleted, since the disconnect should have deleted it and a leftover
// means a removal path to fix, and a kind "error" finding for each prefix
// whose lookup, listing or delete failed. A failed listing of the prefixes
// themselves rejects.
async function orphans({ now = Date.now(), minAge = ORPHAN_MIN_AGE_MS } = {}) {
  const counts = { prefixes: 0, live: 0, removed: 0, spared: 0, ignored: 0, errors: 0, deleted: 0 };
  const findings = [];

  for await (const blogID of listPrefixes()) {
    counts.prefixes++;

    if (!BLOG_ID.test(blogID)) {
      counts.ignored++;
      continue;
    }

    try {
      const blog = await getBlog({ id: blogID });
      if (blog && blog.client === "git") {
        counts.live++;
        continue;
      }

      const store = shadow.objectStoreFor(blogID);
      const keys = [];
      let newest = 0;

      for await (const entry of store.list("")) {
        keys.push(entry.key);
        newest = Math.max(newest, entry.lastModified || 0);
      }

      if (!keys.length) continue;

      if (now - newest < minAge) {
        counts.spared++;
        shadow.log({ blog: blogID, op: "remove", outcome: "spared", reason: "orphan", keys: keys.length, detail: "written in the last " + Math.round(minAge / 3600000) + " hours" });
        continue;
      }

      const again = await getBlog({ id: blogID });
      if (again && again.client === "git") {
        counts.live++;
        continue;
      }

      await each(keys, DELETES_AT_ONCE, (key) => store.delete(key));

      counts.removed++;
      counts.deleted += keys.length;
      findings.push({ blog: blogID, check: "orphan", kind: "orphan", detail: "deleted " + keys.length + " objects left behind" });
      shadow.log({ blog: blogID, op: "remove", outcome: "ok", reason: "orphan", deleted: keys.length });
    } catch (err) {
      const detail = shadow.scrub(err);
      counts.errors++;
      findings.push({ blog: blogID, check: "orphan", kind: "error", detail });
      shadow.log({ blog: blogID, op: "remove", outcome: "error", reason: "orphan", detail });
    }
  }

  return { ...counts, findings };
}

// ---- The daily run --------------------------------------------------------

// Sweeps and checks every shadowed blog, deep checks today's sample, and on
// the first of the month (UTC), or with `orphanSweep`, deletes prefixes left
// behind: that takes a listing per blog in the bucket, and the disconnect
// already deletes a blog's copy twice. Resolves with a report (`orphans` is
// null when they were not looked for); the findings are what the alert email
// is about.
async function daily({ now = Date.now(), deepCount = DEEP_SAMPLE, recheckDelayMs = RECHECK_DELAY_MS, scratchDir = defaultScratchDir(), orphanMinAge = ORPHAN_MIN_AGE_MS, orphanSweep = new Date(now).getUTCDate() === 1 } = {}) {
  const started = Date.now();
  const ids = await gitBlogs();
  const findings = [];
  const sweeps = { ok: 0, errors: 0, packsDeleted: 0, manifestsDeleted: 0, bytesFreed: 0 };
  const passed = new Set();

  await each(ids, BLOGS_AT_ONCE, async (blogID) => {
    const swept = await sweepBlog(blogID);

    if (swept && swept.error) {
      sweeps.errors++;
      findings.push({ blog: blogID, check: "sweep", kind: "error", detail: swept.error });
    } else if (swept) {
      sweeps.ok++;
      sweeps.packsDeleted += swept.packsDeleted || 0;
      sweeps.manifestsDeleted += swept.manifestsDeleted || 0;
      sweeps.bytesFreed += swept.bytesFreed || 0;
    }

    const checked = await verify(blogID, { recheckDelayMs });
    findings.push(...checked.findings);
    if (!checked.skipped && !checked.findings.length) passed.add(blogID);
  });

  // The deep sample, one at a time: each is a whole clone
  const sample = deepSample(ids, deepCount, now);
  const test = await getBlog({ handle: TEST_HANDLE }).catch(() => null);
  if (test && ids.includes(test.id) && !sample.includes(test.id)) sample.push(test.id);

  let deepChecked = 0;
  for (const blogID of sample.filter((id) => passed.has(id))) {
    const checked = await verify(blogID, { deep: true, cheap: false, scratchDir, recheckDelayMs });
    if (checked.deep) deepChecked++;
    findings.push(...checked.findings);
  }

  let orphaned = null;
  if (orphanSweep) {
    try {
      const { findings: failed, ...counts } = await orphans({ now, minAge: orphanMinAge });
      orphaned = counts;
      findings.push(...failed);
    } catch (err) {
      orphaned = { prefixes: 0, live: 0, removed: 0, spared: 0, ignored: 0, errors: 1, deleted: 0 };
      findings.push({ blog: "-", check: "orphan", kind: "error", detail: shadow.scrub(err) });
    }
  }

  return { blogs: ids.length, sweeps, deepChecked, findings, orphans: orphaned, ms: Date.now() - started };
}

function _setPrefixLister(fn) {
  listPrefixes = fn || s3Prefixes;
}

module.exports = {
  gitBlogs,
  sweepBlog,
  verify,
  orphans,
  daily,
  configured,
  defaultScratchDir,
  deepSample,
  DEEP_SAMPLE,
  RECHECK_DELAY_MS,
  _verdict: verdict,
  _setPrefixLister,
};
