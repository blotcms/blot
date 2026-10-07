// Backfill the per-file "applied" modifiedTime records the Google Drive client
// keeps in Redis (see database/folder.js: appliedKey / setApplied), so change
// detection no longer falls back to the local file's mtime. Run this on local
// disk BEFORE moving blog folders to storage that can't set an mtime (S3);
// otherwise every Drive file still lacking a record would be re-downloaded
// once after the move.
//
// Default is a dry run: reports, per blog, how many non-directory files in the
// ID <-> path mapping have no valid applied record. With --apply, blogs with a
// non-zero count are resynced sequentially (clients/google-drive/sync/
// resetFromDrive, i.e. a full sync() pass, which writes an applied record
// whenever a file is downloaded or already identical), under the blog's sync
// lock, then re-counted. This is the same reset as the dashboard's "Resync
// from Google Drive": it clears the blog's ID <-> path mapping before walking
// Drive, so a walk that fails part way leaves a partial mapping until the
// blog's next sync.
//
// Usage:
//   node scripts/google-drive/backfill-applied-modified-times.js [--apply] [blog-identifier]
//
// Runs unattended: no confirmation prompt, even across all blogs. Exits 1 if
// any blog failed.
//
// Note: after --apply a small residue can remain. sync() defers verification
// of old equal-size md5 files past its migration budget and `continue`s
// before writing an applied record for them. Their change detection uses the
// verified-content checksum, not the applied record, so the residue is
// harmless; re-run --apply to shrink it further.

// eachBlogOrOneBlog reads the blog identifier from process.argv[2], so take
// our flag out of argv before it runs.
const apply = process.argv.slice(2).includes("--apply");
process.argv = process.argv.filter((arg, i) => i < 2 || arg !== "--apply");

const client = require("models/client");
const eachBlogOrOneBlog = require("../each/eachBlogOrOneBlog");
const database = require("clients/google-drive/database");
const resetFromDrive = require("clients/google-drive/sync/resetFromDrive");
const establishSyncLock = require("sync/establishSyncLock");

const SCAN_COUNT = 1000;

let totalGoogleDriveBlogs = 0;
let totalFiles = 0;
let totalMissing = 0;
let successfulResyncs = 0;
let failedResyncs = 0;
let totalRemaining = 0;
const needsResync = [];
const errors = [];

const label = (blog) => `${blog.handle || "no handle"} ${blog.id}`;

const formatError = (err) => (err && err.message ? err.message : String(err));

// Scans the ID <-> path mapping a page at a time, reading metadata for each
// page with a single HMGET, and compares against the applied hash (read once).
const countMissing = async (folderId, blogID) => {
  const folder = database.folder(folderId, blogID);
  const applied = await folder.getAllApplied();

  let files = 0;
  let missing = 0;
  let cursor = "0";

  do {
    const page = await client.hScan(folder.key, cursor, { COUNT: SCAN_COUNT });
    cursor = page.cursor;

    const ids = page.entries.map((entry) => entry.field);
    if (!ids.length) continue;

    const metadata = await client.hmGet(folder.metadataKey, ids);

    ids.forEach((id, i) => {
      let isDirectory = false;
      try {
        isDirectory = Boolean(metadata[i] && JSON.parse(metadata[i]).isDirectory);
      } catch (_) {}

      if (isDirectory) return;

      files++;
      if (!applied.get(id)) missing++;
    });
  } while (String(cursor) !== "0");

  return { files, missing };
};

const resync = async (blog) => {
  let lock;

  try {
    lock = await establishSyncLock(blog.id);
  } catch (err) {
    throw new Error(`could not acquire sync lock: ${formatError(err)}`);
  }

  const { folder, done } = lock;
  let result;

  try {
    folder.status("Google Drive applied modifiedTime backfill");
    result = await resetFromDrive(blog.id, folder.status, folder.update);
  } finally {
    try {
      await done();
    } catch (err) {
      console.error(
        `WARN: failed to release sync lock for ${blog.id}: ${formatError(err)}`
      );
    }
  }

  // sync() resolves false when the walk fails part way through
  if (!result) throw new Error("sync did not complete");
};

const processBlog = async (blog) => {
  if (!blog || blog.isDisabled) return;
  if (blog.client !== "google-drive") return;

  totalGoogleDriveBlogs++;

  try {
    const account = await database.blog.get(blog.id);
    const folderId = account && account.folderId;

    if (!folderId) {
      console.log(`${label(blog)}: no Google Drive folder set up, skipping`);
      return;
    }

    const { files, missing } = await countMissing(folderId, blog.id);

    totalFiles += files;
    totalMissing += missing;

    console.log(
      `${label(blog)}: ${missing} of ${files} files missing applied modifiedTime`
    );

    if (!missing) return;

    needsResync.push(blog);

    if (!apply) return;

    console.log(`Starting Google Drive resync for ${label(blog)}`);

    try {
      await resync(blog);
      successfulResyncs++;
      console.log(`✅ Completed Google Drive resync for ${label(blog)}`);
    } catch (err) {
      failedResyncs++;
      console.error(
        `❌ Google Drive resync failed for ${label(blog)}:`,
        formatError(err)
      );
      errors.push({ blogID: blog.id, handle: blog.handle, error: formatError(err) });
      return;
    }

    const after = await countMissing(folderId, blog.id);
    totalRemaining += after.missing;

    console.log(
      `${label(blog)}: ${after.missing} of ${after.files} files still missing applied modifiedTime` +
        (after.missing
          ? " (expected to be ~0; old md5 files whose verification was deferred by sync's migration budget may remain, re-run to reduce)"
          : "")
    );
  } catch (err) {
    failedResyncs++;
    console.error(`❌ Failed to process ${label(blog)}:`, formatError(err));
    errors.push({ blogID: blog.id, handle: blog.handle, error: formatError(err) });
  }
};

const summarize = () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log(
    `Google Drive applied modifiedTime backfill${apply ? "" : " (dry run)"}:`
  );
  console.log(`  Google Drive blogs checked: ${totalGoogleDriveBlogs}`);
  console.log(`  Files missing applied modifiedTime: ${totalMissing} of ${totalFiles}`);
  console.log(`  Blogs needing a resync: ${needsResync.length}`);

  needsResync.forEach((blog) => console.log(`    ${label(blog)}`));

  if (apply) {
    console.log(`  Successful resyncs: ${successfulResyncs}`);
    console.log(`  Failed: ${failedResyncs}`);
    console.log(`  Files still missing after resync: ${totalRemaining}`);
    if (totalRemaining) {
      console.log(
        "  (A residue is expected for old md5 files deferred by sync's verification budget; their change detection doesn't use the applied record. Re-run to reduce it.)"
      );
    }
  } else if (needsResync.length) {
    console.log("\nRe-run with --apply to resync these blogs.");
  }

  if (errors.length > 0) {
    console.log("\nErrors:");
    errors.slice(0, 10).forEach((error) => {
      console.log(
        `  Blog ${error.blogID} (${error.handle || "no handle"}): ${error.error}`
      );
    });
    if (errors.length > 10) {
      console.log(`  ... and ${errors.length - 10} more errors`);
    }
  }
};

if (require.main === module) {
  const identifier = process.argv[2];

  console.log(
    `${apply ? "Applying" : "Dry run of"} Google Drive applied modifiedTime backfill for ${
      identifier ? `blog ${identifier}` : "all Google Drive blogs"
    }...\n`
  );

  eachBlogOrOneBlog(processBlog, { confirm: false })
    .then(() => {
      summarize();
      process.exit(failedResyncs > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error("Backfill failed:", formatError(err));
      process.exit(1);
    });
}

module.exports = processBlog;
