// Moves the git store's copies from the old top-level prefix, git/<blogID>/,
// to <blogID>/git/ in the storage bucket (#2259; config/storage-bucket/
// README.md says why). Run it once, just after the deploy that moves the store
// to <blogID>/git/: until then the app reads and writes the old prefix.
//
// For each blog under git/: copies every object to the new prefix (a copy
// inside the bucket, nothing downloaded), checks each copy's size, then
// deletes the old objects. A blog whose new prefix already holds anything is
// left alone and reported: a push mirrored after the deploy and before the
// move started a new copy there, so repair that blog with
// `scripts/git/backfill-store.js --blog <blogID> --reset` and delete its old
// prefix by hand. Objects over 5 GB can't be copied in one request; a blog
// with one is reported and left alone. Safe to run again: a blog already
// moved has nothing left under git/.
//
// Usage, on the production host:
//
//   docker exec -u 1000 blot-blue node scripts/git/move-store-prefix.js [--dry-run]
//
// Prints one line per blog and a summary. Exits 0 when every blog moved, 1 if
// any did not, 2 for bad arguments.
const s3 = require("storage/s3");

const OLD = "git/";
const BLOG_ID = /^blog_[0-9A-Za-z]+$/;
const COPIES_AT_ONCE = 8;
const MAX_COPY_BYTES = 5 * 1024 * 1024 * 1024;

async function each(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function list(prefix) {
  const entries = [];
  for await (const entry of s3.listEntries(prefix)) if (entry.key) entries.push(entry);
  return entries;
}

async function moveBlog(blogID, dryRun) {
  const from = OLD + blogID + "/";
  const to = blogID + "/git/";
  const objects = await list(from);
  const bytes = objects.reduce((sum, o) => sum + o.size, 0);

  if (!objects.length) return { outcome: "empty" };
  if ((await list(to)).length) return { outcome: "skipped", detail: "the new prefix is not empty", objects: objects.length };
  if (objects.some((o) => o.size > MAX_COPY_BYTES)) return { outcome: "skipped", detail: "an object over 5 GB", objects: objects.length };
  if (dryRun) return { outcome: "would-move", objects: objects.length, bytes };

  await each(objects, COPIES_AT_ONCE, async (o) => {
    const target = to + o.key.slice(from.length);
    await s3.copy(o.key, target);
    const copied = await s3.head(target);
    if (!copied || copied.size !== o.size) throw new Error("copy of " + o.key.slice(from.length) + " is the wrong size");
  });

  const keys = objects.map((o) => o.key);
  for (let i = 0; i < keys.length; i += 1000) await s3.deleteKeys(keys.slice(i, i + 1000));

  return { outcome: "moved", objects: objects.length, bytes };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  if (args.some((arg) => arg !== "--dry-run")) {
    console.error("Usage: node scripts/git/move-store-prefix.js [--dry-run]");
    process.exit(2);
  }

  s3.assertConfigured();

  const blogs = [];
  for await (const entry of s3.listEntries(OLD, "/")) {
    if (entry.prefix) blogs.push(entry.prefix.slice(OLD.length).replace(/\/$/, ""));
    else if (entry.key) console.log("[git-store-move] key=" + entry.key + " outcome=skipped detail=not under a blog");
  }

  const counts = {};
  for (const blogID of blogs) {
    let result;
    if (!BLOG_ID.test(blogID)) result = { outcome: "skipped", detail: "not a blog ID" };
    else {
      try {
        result = await moveBlog(blogID, dryRun);
      } catch (err) {
        result = { outcome: "error", detail: err.message };
      }
    }

    counts[result.outcome] = (counts[result.outcome] || 0) + 1;
    const fields = Object.entries(result).map(([k, v]) => k + "=" + (k === "detail" ? JSON.stringify(v) : v));
    console.log("[git-store-move] blog=" + blogID + " " + fields.join(" "));
  }

  console.log("[git-store-move] done blogs=" + blogs.length + " " + Object.entries(counts).map(([k, v]) => k + "=" + v).join(" "));
  process.exit(counts.error || counts.skipped ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
