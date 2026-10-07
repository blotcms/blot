// Stores a contentHash on every entry that doesn't have one yet, without
// touching 'updated'. app/build only keeps 'updated' stable across an
// unchanged re-upload once an entry has a stored hash; entries built before
// contentHash existed take the file's mtime "this once". That once must
// happen on local disk, not after blog folders move to S3, where the mtime
// is the upload time and every such post would show the migration date.
//
// Dry run by default. Pass --apply to write.
// Usage: node scripts/entry/backfill-content-hash.js [blog-identifier] [--apply]

const Blog = require("models/blog");
const Entries = require("models/entries");
const client = require("models/client");
const key = require("models/entry/key");
const sync = require("sync");
const { hashEntrySource } = require("build");
const getBlog = require("../get/blog");

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const identifier = args.find((arg) => !arg.startsWith("--"));

const totals = { entries: 0, missing: 0, stored: 0, unreadable: 0, changed: 0 };
let failed = 0;

function sourcePathsFor(entry) {
  const sourcePaths = entry.metadata && entry.metadata._sourcePaths;
  return Array.isArray(sourcePaths) && sourcePaths.length
    ? sourcePaths
    : [entry.path];
}

function hash(blog, entry) {
  return new Promise((resolve) => {
    hashEntrySource(blog, sourcePathsFor(entry), (err, contentHash) =>
      resolve(err ? null : contentHash)
    );
  });
}

function eachEntry(blogID, fn) {
  return new Promise((resolve, reject) => {
    Entries.each(
      blogID,
      (entry, next) => fn(entry).then(() => next(), next),
      (err) => (err ? reject(err) : resolve())
    );
  });
}

async function backfill(blog) {
  const counts = { entries: 0, missing: 0, stored: 0, unreadable: 0, changed: 0 };

  await eachEntry(blog.id, async (entry) => {
    counts.entries++;

    // Deleted entries expire and are never compared against again.
    if (entry.deleted || entry.contentHash) return;

    counts.missing++;

    const contentHash = await hash(blog, entry);

    if (!contentHash) {
      counts.unreadable++;
      return;
    }

    if (!apply) return;

    // Write the stored JSON directly rather than through Entry.set, which
    // would re-run URL assignment, list membership, backlinks and draft
    // notifications for every entry.
    const entryKey = key.entry(blog.id, entry.path);
    const stored = JSON.parse((await client.get(entryKey)) || "null");

    // A build landed in between (only possible for disabled blogs, which
    // are processed without the sync lock); it already did the work.
    if (!stored || stored.deleted || stored.contentHash || stored.updated !== entry.updated) {
      counts.changed++;
      return;
    }

    stored.contentHash = contentHash;
    await client.set(entryKey, JSON.stringify(stored));
    counts.stored++;
  });

  return counts;
}

// Hold the blog's sync lock so no build can write the entry between our
// read and write. sync() refuses disabled blogs, but nothing else writes
// their entries either, so they're processed without it.
function withLock(blog, fn) {
  if (!apply || blog.isDisabled) return fn();

  return new Promise((resolve, reject) => {
    sync(blog.id, (err, folder, done) => {
      if (err) return reject(err);

      fn().then(
        (counts) => done(null, (err) => (err ? reject(err) : resolve(counts))),
        (fnErr) => done(fnErr, () => reject(fnErr))
      );
    });
  });
}

async function processBlog(blog) {
  const counts = await withLock(blog, () => backfill(blog));

  for (const name in totals) totals[name] += counts[name];

  if (counts.missing) {
    console.log(
      `${blog.handle} ${blog.id}: ${counts.missing} of ${counts.entries} entries missing contentHash,`,
      apply ? `${counts.stored} stored,` : "",
      `${counts.unreadable} unreadable`,
      counts.changed ? `, ${counts.changed} changed underneath` : ""
    );
  }
}

function blogIDs() {
  if (!identifier) {
    return new Promise((resolve, reject) =>
      Blog.getAllIDs((err, ids) => (err ? reject(err) : resolve(ids)))
    );
  }

  return new Promise((resolve, reject) =>
    getBlog(identifier, (err, user, blog) =>
      err || !blog ? reject(err || new Error("No blog: " + identifier)) : resolve([blog.id])
    )
  );
}

async function main() {
  console.log(apply ? "Writing contentHash" : "Dry run (pass --apply to write)");

  for (const blogID of await blogIDs()) {
    const blog = await new Promise((resolve, reject) =>
      Blog.get({ id: blogID }, (err, blog) => (err ? reject(err) : resolve(blog)))
    );

    if (!blog) continue;

    try {
      await processBlog(blog);
    } catch (err) {
      failed++;
      console.error(`${blog.handle} ${blog.id}: failed:`, err.message || err);
    }
  }

  console.log(
    `Entries: ${totals.entries}. Missing contentHash: ${totals.missing}.`,
    apply ? `Stored: ${totals.stored}.` : "",
    `Unreadable source (left for the next build): ${totals.unreadable}.`,
    totals.changed ? `Changed underneath: ${totals.changed}.` : "",
    failed ? `Failed blogs: ${failed}.` : ""
  );
}

main()
  .then(() => process.exit(failed ? 1 : 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
