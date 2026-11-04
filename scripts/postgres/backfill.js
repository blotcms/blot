// Copies every blog's entries, tags and dependencies from Redis into Postgres,
// or checks that the two agree.
//
// The writes are the ones live saves make (models/postgres/entries syncPaths),
// so this runs safely alongside them, takes no sync lock, and can be stopped
// and run again at any time: each run makes the rows match Redis as it is.
// Run it once the dual-write code is deployed, so no save is missed between
// the copy and the deploy.
//
// Usage:
//   node scripts/postgres/backfill.js [blog-identifier]
//       copy (every blog, or one by handle, domain or ID prefix)
//   node scripts/postgres/backfill.js [blog-identifier] --verify
//       compare only: lists entry rows which differ from Redis, and the
//       Redis indexes (lists, tags, dependents, URLs) the Postgres queries
//       disagree with
//   node scripts/postgres/backfill.js [blog-identifier] --verify --fix
//       compare, then re-sync the entries which differ
//   node scripts/postgres/backfill.js --dirty
//       repair the blogs whose live write failed, as the hourly job does
//   -s <n> start at the nth blog (by ID), to resume a run
const postgres = require("models/postgres");
const entries = require("models/postgres/entries");
const verifyBlog = require("models/postgres/verify");
const Blog = require("models/blog");
const { promisify } = require("util");

const getAllIDs = promisify(Blog.getAllIDs);

const args = process.argv.slice(2);
const verify = args.includes("--verify");
const fix = args.includes("--fix");
const dirty = args.includes("--dirty");
const options = {};
const positional = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "-s") options.start = parseInt(args[++i], 10);
  else if (!args[i].startsWith("--")) positional.push(args[i]);
}

const identifier = positional[0];
const totals = { blogs: 0, written: 0, removed: 0, failed: 0, differ: 0, indexes: 0 };

async function processBlog(blogID, label) {
  totals.blogs++;

  if (!verify) {
    const result = await entries.syncBlog(blogID);
    totals.written += result.written;
    totals.removed += result.removed;
    console.log(label, blogID, "written", result.written, "removed", result.removed);
    return;
  }

  const report = await verifyBlog(blogID);
  const e = report.entries;

  if (report.ok) {
    console.log(label, blogID, "ok", e.redis, "entries");
    return;
  }

  totals.differ += report.paths.length ? 1 : 0;
  totals.indexes += report.indexes.length ? 1 : 0;

  console.log(
    label,
    blogID,
    "entries: redis",
    e.redis,
    "postgres",
    e.postgres,
    "missing",
    e.missing.length,
    "extra",
    e.extra.length,
    "different",
    e.different.length
  );

  for (const path of report.paths.slice(0, 10)) console.log("    entry", path);
  for (const index of report.indexes.slice(0, 20)) {
    console.log(
      "    " + index.name,
      "missing",
      index.missing,
      "extra",
      index.extra,
      JSON.stringify(index.sample)
    );
  }
  if (report.indexes.length > 20) console.log("    ...", report.indexes.length - 20, "more indexes");

  if (fix && report.paths.length) {
    const result = await entries.syncPaths(blogID, report.paths);
    totals.written += result.written;
    totals.removed += result.removed;
    console.log("    fixed: written", result.written, "removed", result.removed);
  }
}

function run(blogID, label) {
  return processBlog(blogID, label).catch((err) => {
    totals.failed++;
    console.error(label, blogID, "FAILED", err.message);
  });
}

// A blog ID, ID prefix, handle or domain
async function resolve(identifier, blogIDs) {
  if (blogIDs.includes(identifier)) return identifier;

  const get = (by) =>
    new Promise((resolve) => Blog.get(by, (err, blog) => resolve(err ? null : blog)));

  const blog = (await get({ handle: identifier })) || (await get({ domain: identifier }));
  if (blog) return blog.id;

  const matches = blogIDs.filter((id) => id.startsWith(identifier));
  if (matches.length === 1) return matches[0];

  throw new Error(matches.length ? "Ambiguous blog " + identifier : "No blog " + identifier);
}

async function main() {
  if (!postgres.enabled()) throw new Error("Set BLOT_POSTGRES_URL first");

  if (dirty) {
    const result = await entries.repairDirty({ log: (...line) => console.log(...line) });
    console.log("Repaired", result.repaired, "blogs,", result.failed, "failed");
    return;
  }

  // Every blog ID in Redis, sorted so -s means the same on every run. A blog
  // whose record is gone still has its rows synced (and so removed).
  const blogIDs = (await getAllIDs()).sort();

  if (identifier) {
    const blogID = await resolve(identifier, blogIDs);
    await run(blogID, "[1/1]");
  } else {
    for (let i = (options.start || 1) - 1; i < blogIDs.length; i++) {
      await run(blogIDs[i], "[" + (i + 1) + "/" + blogIDs.length + "]");
    }
  }

  console.log(JSON.stringify(totals));
  if (totals.failed) process.exitCode = 1;
}

main()
  .then(() => postgres.end())
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
