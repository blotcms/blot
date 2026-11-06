// The git store's upkeep (#2259), run once a day by the scheduler
// (app/scheduler/git-store-maintenance.js), and by hand with
// scripts/git/verify-store.js:
//
//   gitBlogs({ ids })         the blogs on the git client
//   sweepBlog(blogID)         the store's sweep(), with its defaults
//   verify(blogID, options)   checks the blog's repository in the store
//   orphans(options)          deletes <blogID>/git/ prefixes left behind by
//                             blogs no longer on git
//   scratch(options)          removes the import-, verify-, rewrite- and
//                             setup- directories a killed process left in the
//                             scratch directory (store/leftovers.js)
//   daily(options)            all of the above, for every blog on git; the
//                             orphans only on the first of the month
//
// The store is the only copy of each repository, so the verifier checks the
// copy on its own, with the store's checks (store/check.js, which
// scripts/git/check-store.js also runs on an explicit target):
//
//   cheap  the newest manifest has the repository (a blog on git with an
//          empty store has lost it), it is not older than the one
//          latest.json names, and every file it names is in the bucket, at
//          the size it says: each pack's .pack, .idx and .rev, and the
//          history pack's and pieces' .pack and .idx (they have no .rev).
//          The hint's GET, one manifest read and a HEAD a file.
//   deep   a clone of the store through its own clone code, into scratch,
//          index-pack --strict, fsck --strict, and every branch, tag, HEAD
//          and peeled tag of the manifest made in it (the store's
//          verifyImport, with no source). A sample of blogs a day, in turn,
//          and the git test blog.
//
// A write in flight (a compaction swapping packs, say) can make a check find
// something for a moment, so a check which finds anything is run once more
// after a short delay, and only what that finds counts. Each finding is
// logged:
//
//   [git-store-served] blog=<id> op=verify outcome=ok|mismatch|missing|error
//     check=cheap|deep ... detail=...
//
// Blog handles stay out of the logs.
const path = require("path");
const config = require("config");
const Blog = require("models/blog");
const { layout } = require("../store");
const sweep = require("../store/sweep");
const check = require("../store/check");
const { sweepScratch } = require("../store/leftovers");
const limiter = require("../limiter");
const counting = require("./counting");
const context = require("./context");
const log = require("./log");
const { measure } = counting;

const DAY = 24 * 60 * 60 * 1000;

// How many blogs a day get the deep check, besides the git test blog. The
// sample moves on each day, so every blog is cloned in turn.
const DEEP_SAMPLE = 5;

// The handle of the production test blog for the git client, which is deep
// checked every day
const TEST_HANDLE = "gittest";

// How long to wait before checking a blog again, when the first check found
// something
const RECHECK_DELAY_MS = 60 * 1000;

// A prefix left by a blog off git is only deleted once nothing has been
// written to it for this long, so a reconnect in flight is not touched. It
// also deletes the manifests a removal keeps (store/remove.js), after which a
// reconnect numbers its manifests from 1 again; that is only safe once no
// process can still build on a manifest from before, so this is twice the
// age a swap allows its base (store/manifest.js, MAX_BASE_AGE), as the sweep's
// recovery window is.
const ORPHAN_MIN_AGE_MS = 2 * DAY;

// Blogs checked at once
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
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
}

function getBlog(by) {
  return new Promise((resolve, reject) =>
    Blog.get(by, (err, blog) => (err ? reject(err) : resolve(blog || null)))
  );
}

function allBlogIDs() {
  return new Promise((resolve, reject) =>
    Blog.getAllIDs((err, ids) => (err ? reject(err) : resolve(ids || [])))
  );
}

// An error's message on one line
function scrub(err) {
  return String((err && (err.message || err)) || "unknown error")
    .replace(/\s+/g, " ")
    .trim();
}

// The gate the store's git goes through: the background lane, with each wait
// on the operation's lane clock (./counting.js), so waitMs records it and ms
// leaves it out
function gate(start) {
  const granted = counting.waiting();

  return limiter
    .run("background", () => {
      granted();
      return start();
    })
    .finally(granted);
}

// Where a deep check builds its clone: the directory the store's cache lives
// in, on the host's instance store in production (tmp), which has far more
// room than the cache's budget
function defaultScratchDir() {
  return path.dirname(config.git_store.cache_directory);
}

// Removes what a killed import, verify, rewrite or setup left in the scratch
// directory (a deploy replacing a container mid-import), judged by age alone:
// the directory is shared by processes which cannot see each other. Logs one
// line, without paths. Never throws.
async function scratch({
  scratchDir = defaultScratchDir(),
  minAge,
  now = Date.now(),
} = {}) {
  try {
    const result = await sweepScratch({ dir: scratchDir, minAge, now });
    log({
      op: "sweep",
      source: "scratch",
      outcome: result.errors ? "error" : "ok",
      ...result,
    });
    return result;
  } catch (err) {
    log({
      op: "sweep",
      source: "scratch",
      outcome: "error",
      detail: scrub(err),
    });
    return { removed: 0, spared: 0, bytes: 0, errors: 1, failed: scrub(err) };
  }
}

// Whether there is a store to look after
function configured() {
  return context.hasStore();
}

// The blog's store, or null if the blog is gone or off git
async function storeOf(blogID) {
  const blog = await getBlog({ id: blogID });
  if (!blog || blog.client !== "git") return null;
  return context.storeFor(blogID);
}

// ---- Which blogs ----------------------------------------------------------

// The IDs of the blogs on the git client, sorted. `ids` limits them to those
// blogs. There is no index of blogs by client, so this walks every blog.
async function gitBlogs({ ids = null } = {}) {
  const candidates = ids || (await allBlogIDs());
  const found = [];

  await each([...new Set(candidates)], 16, async (blogID) => {
    const blog = await getBlog({ id: blogID });
    if (blog && blog.client === "git") found.push(blogID);
  });

  return found.sort();
}

// ---- The sweep ------------------------------------------------------------

async function sweepBlog(blogID) {
  const store = await storeOf(blogID);
  if (!store) return null;

  try {
    const measured = await measure(() => sweep({ store }));
    const stats = measured.result;

    log({
      blog: blogID,
      op: "sweep",
      outcome: "ok",
      ms: measured.ms,
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
    log({ blog: blogID, op: "sweep", outcome: "error", detail: scrub(err) });
    return { error: scrub(err) };
  }
}

// ---- The verifier ---------------------------------------------------------

// The cheap check (store/check.js). A blog on git with an empty store, or a
// removal's tombstone, has lost its repository.
async function cheapCheck(store) {
  const result = await check.cheapCheck(store);
  if (result.state !== "ok")
    result.findings.unshift({
      kind: "missing",
      detail: "the store has no copy of the repository",
    });
  return result;
}

// The deep check (store/check.js). A verdict on the store is a finding; any
// other failure is thrown, so twice() counts it as an error.
function deepCheck(store, scratchDir) {
  return check.deepCheck({ store, cache: context.cache(), scratchDir, gate });
}

// Runs a check, and once more after a delay if it found anything; a check
// which throws is an "error" finding
async function twice(check, recheckDelayMs) {
  let result;

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 2) await sleep(recheckDelayMs);

    try {
      result = await measure(check);
      result.attempts = attempt;
      if (!result.result.findings.length) return result;
    } catch (err) {
      result = {
        result: { findings: [{ kind: "error", detail: scrub(err) }] },
        attempts: attempt,
        ms: 0,
        counts: {},
      };
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
    ms: measured.ms,
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

  if (!findings.length) log({ ...fields, outcome: "ok" });
  for (const finding of findings)
    log({ ...fields, outcome: finding.kind, detail: finding.detail });

  return findings.map((finding) => ({ blog: blogID, check, ...finding }));
}

// Checks one blog: the cheap check, and with `deep` the deep one too (only if
// the cheap one passed; `cheap: false` skips it, for a blog which has just
// had it). Resolves with { blog, skipped, deep, findings }; never rejects for
// a failure of the check itself, which is an "error" finding.
async function verify(
  blogID,
  {
    deep = false,
    cheap = true,
    scratchDir = defaultScratchDir(),
    recheckDelayMs = RECHECK_DELAY_MS,
  } = {}
) {
  let store;

  try {
    store = await storeOf(blogID);
  } catch (err) {
    log({ blog: blogID, op: "verify", outcome: "error", detail: scrub(err) });
    return {
      blog: blogID,
      findings: [
        { blog: blogID, check: "lookup", kind: "error", detail: scrub(err) },
      ],
      deep: false,
    };
  }

  if (!store) {
    log({
      blog: blogID,
      op: "verify",
      outcome: "skipped",
      detail: "the blog is gone or off git",
    });
    return { blog: blogID, skipped: true, deep: false, findings: [] };
  }

  if (cheap) {
    const found = report(
      blogID,
      "cheap",
      await twice(() => cheapCheck(store), recheckDelayMs)
    );
    if (found.length || !deep)
      return { blog: blogID, findings: found, deep: false };
  }

  const deepFindings = report(
    blogID,
    "deep",
    await twice(() => deepCheck(store, scratchDir), recheckDelayMs)
  );
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
// in another process left after the disconnect's two passes (./remove.js), or
// a disconnect cut off by a restart. A blog on git is never touched, and is
// looked up again just before the delete. Only the keys listed are deleted,
// so anything written after the listing is left. Resolves with counts, and
// `findings` for the alert email: a kind "orphan" finding for each prefix
// deleted that held more than the manifests the disconnect's removal keeps
// (store/remove.js), since it should have deleted the rest and a leftover
// means a removal path to fix, and a kind "error" finding for each prefix
// whose lookup, listing or delete failed. A failed listing of the prefixes
// themselves rejects.
async function orphans({ now = Date.now(), minAge = ORPHAN_MIN_AGE_MS } = {}) {
  const counts = {
    prefixes: 0,
    live: 0,
    removed: 0,
    spared: 0,
    ignored: 0,
    errors: 0,
    deleted: 0,
  };
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

      const store = context.objectStoreFor(blogID);
      const keys = [];
      let newest = 0;

      for await (const entry of store.list("")) {
        keys.push(entry.key);
        newest = Math.max(newest, entry.lastModified || 0);
      }

      if (!keys.length) continue;

      if (now - newest < minAge) {
        counts.spared++;
        log({
          blog: blogID,
          op: "remove",
          outcome: "spared",
          reason: "orphan",
          keys: keys.length,
          detail:
            "written in the last " + Math.round(minAge / 3600000) + " hours",
        });
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

      // Only manifests is what a removal leaves on purpose (store/remove.js)
      if (keys.every((key) => key.startsWith(layout.MANIFEST_PREFIX))) {
        log({
          blog: blogID,
          op: "remove",
          outcome: "ok",
          reason: "tombstone",
          deleted: keys.length,
        });
        continue;
      }

      findings.push({
        blog: blogID,
        check: "orphan",
        kind: "orphan",
        detail: "deleted " + keys.length + " objects left behind",
      });
      log({
        blog: blogID,
        op: "remove",
        outcome: "ok",
        reason: "orphan",
        deleted: keys.length,
      });
    } catch (err) {
      const detail = scrub(err);
      counts.errors++;
      findings.push({ blog: blogID, check: "orphan", kind: "error", detail });
      log({
        blog: blogID,
        op: "remove",
        outcome: "error",
        reason: "orphan",
        detail,
      });
    }
  }

  return { ...counts, findings };
}

// ---- The daily run --------------------------------------------------------

// Sweeps and checks every blog on git, deep checks today's sample, and on the
// first of the month (UTC), or with `orphanSweep`, deletes prefixes left
// behind: that takes a listing per blog in the bucket, and the disconnect
// already deletes a blog's copy twice. Resolves with a report (`orphans` is
// null when they were not looked for); the findings are what the alert email
// is about. `ids` limits it to those blogs (for specs).
async function daily({
  now = Date.now(),
  ids: only = null,
  deepCount = DEEP_SAMPLE,
  recheckDelayMs = RECHECK_DELAY_MS,
  scratchDir = defaultScratchDir(),
  orphanMinAge = ORPHAN_MIN_AGE_MS,
  orphanSweep = new Date(now).getUTCDate() === 1,
} = {}) {
  const started = Date.now();
  const ids = await gitBlogs({ ids: only });
  const findings = [];
  const sweeps = {
    ok: 0,
    errors: 0,
    packsDeleted: 0,
    manifestsDeleted: 0,
    bytesFreed: 0,
  };
  const passed = new Set();

  await each(ids, BLOGS_AT_ONCE, async (blogID) => {
    const swept = await sweepBlog(blogID);

    if (swept && swept.error) {
      sweeps.errors++;
      findings.push({
        blog: blogID,
        check: "sweep",
        kind: "error",
        detail: swept.error,
      });
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
  if (test && ids.includes(test.id) && !sample.includes(test.id))
    sample.push(test.id);

  let deepChecked = 0;
  const deepBlogs = [];
  for (const blogID of sample.filter((id) => passed.has(id))) {
    const checked = await verify(blogID, {
      deep: true,
      cheap: false,
      scratchDir,
      recheckDelayMs,
    });
    if (checked.deep) {
      deepChecked++;
      deepBlogs.push(blogID);
    }
    findings.push(...checked.findings);
  }

  let orphaned = null;
  if (orphanSweep) {
    try {
      const { findings: failed, ...counts } = await orphans({
        now,
        minAge: orphanMinAge,
      });
      orphaned = counts;
      findings.push(...failed);
    } catch (err) {
      orphaned = {
        prefixes: 0,
        live: 0,
        removed: 0,
        spared: 0,
        ignored: 0,
        errors: 1,
        deleted: 0,
      };
      findings.push({
        blog: "-",
        check: "orphan",
        kind: "error",
        detail: scrub(err),
      });
    }
  }

  const leftovers = await scratch({ scratchDir, now });
  if (leftovers.failed)
    findings.push({
      blog: "-",
      check: "scratch",
      kind: "error",
      detail: leftovers.failed,
    });

  return {
    blogs: ids.length,
    sweeps,
    deepChecked,
    deepBlogs,
    findings,
    orphans: orphaned,
    scratch: leftovers,
    ms: Date.now() - started,
  };
}

function _setPrefixLister(fn) {
  listPrefixes = fn || s3Prefixes;
}

module.exports = {
  gitBlogs,
  sweepBlog,
  verify,
  orphans,
  scratch,
  daily,
  configured,
  defaultScratchDir,
  deepSample,
  DEEP_SAMPLE,
  RECHECK_DELAY_MS,
  _verdict: check.verdict,
  _setPrefixLister,
};
