// Rebuilds a blog's folder index (models/file) from a full listing of its
// folder in the storage bucket, {blogID}/folder/. Only for blogs with a copy
// in S3 (mirrored and backfilled, or on S3): for any other blog the listing
// is empty and the index would be emptied.
//
// For a blog on S3 (config.folder_primary, #2258 Phase D), the index is what
// every read goes by, and --apply empties it before refilling it: reads which
// came in meanwhile (visitors take no lock) would see a partial or empty
// folder. So --apply refuses a blog on S3, unless --via-disk: then, under the
// blog's sync lock, it checks the blog's disk copy is not behind S3, marks
// the blog's mirror behind (mirror.markBehind), which sends its reads to the
// disk copy, waits a moment for reads already sent to S3, and rebuilds. The
// blog is left in the mirror's dirty set, so the next hourly reconcile
// compares S3 and the index with the disk, repairs what differs, and puts the
// blog back on S3 by itself. Until then it is served from disk, and its
// changes are mirrored to S3 as for any blog on disk.
//
//   node scripts/storage/rebuild-file-index.js <blogID> [--apply] [--no-hash] [--via-disk]
//
// Without --apply it only lists the bucket and reports what the index would
// hold, next to what it holds now. With --apply it replaces the index, under
// the blog's sync lock so no sync writes while it runs. Files are downloaded
// to compute their SHA-1 unless --no-hash; without hashes, ensureLocal still
// works but anything which compares hashes sees every file as changed.
//
// A file's modified time becomes the time its object was written, so a time
// kept by a move into the folder is lost. S3 can hold a file "a" beside
// objects below "a/", which a folder cannot: those objects are skipped and
// listed, in the dry run and with --apply alike.

const s3 = require("storage/s3");
const File = require("models/file");
const Blog = require("models/blog");
const hold = require("sync/hold");
const backend = require("storage/folder/s3");
const mirror = require("storage/folder/mirror");
const primary = require("storage/folder/primary");
const client = require("models/client");
const { promisify } = require("util");

// How long reads which chose S3 just before the blog was marked behind get
// to finish before its index is emptied
const SETTLE_MS = 2000;

function usage(message) {
  if (message) console.error(message + "\n");

  console.error("Usage: node scripts/storage/rebuild-file-index.js <blogID> [--apply] [--no-hash] [--via-disk]");
  process.exit(2);
}

function parse(argv) {
  const options = { apply: false, hash: true, viaDisk: false };

  for (const arg of argv) {
    if (arg === "--apply") options.apply = true;
    else if (arg === "--no-hash") options.hash = false;
    else if (arg === "--via-disk") options.viaDisk = true;
    else if (arg.startsWith("--")) usage("Unknown argument " + arg);
    else if (options.blogID) usage("Only one blogID");
    else options.blogID = arg;
  }

  if (!options.blogID) usage();

  return options;
}

// What a listing would put in the index, without writing it. A record which
// conflicts with one before it (something below a file, or a file and a
// directory at one path) is skipped, as models/file's rebuild skips it.
async function count(blogID, options) {
  const files = new Map();
  const dirs = new Set();
  const skipped = [];
  let bytes = 0;

  for await (const record of backend.indexRecords(blogID, options)) {
    const parts = record.path.split("/").slice(1);
    const ancestors = [];

    for (let i = 1; i < parts.length; i++) ancestors.push("/" + parts.slice(0, i).join("/"));

    let code = null;

    if (ancestors.some((ancestor) => files.has(ancestor))) code = "ENOTDIR";
    else if (record.type === "dir" && files.has(record.path)) code = "EEXIST";
    else if (record.type !== "dir" && dirs.has(record.path)) code = "EISDIR";

    if (code) {
      skipped.push({ path: record.path, type: record.type, code });
      continue;
    }

    // Every ancestor is a directory, whether it has a marker or not
    for (const ancestor of ancestors) dirs.add(ancestor);

    if (record.type === "dir") {
      dirs.add(record.path);
    } else {
      bytes += record.size - (files.get(record.path) || 0);
      files.set(record.path, record.size);
    }
  }

  return { files: files.size, dirs: dirs.size, bytes, skipped };
}

// Prints the totals, then each skipped object on its own line
function report(label, counts) {
  const { skipped, ...totals } = counts;

  console.log(label, totals);

  if (skipped.length) {
    console.log(skipped.length + " objects skipped, which conflict with one listed before them:");
    for (const item of skipped) console.log("  " + item.code + " " + item.type + " " + JSON.stringify(item.path));
  }
}

function failure(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Replaces a blog's index with one built from S3, under its sync lock.
// Rejects with EONS3 for a blog on S3 unless options.viaDisk, and with
// ECONFLICT if its disk copy is behind S3 (see the header). Resolves to what
// models/file's rebuild counted, plus { viaDisk } when the blog was sent to
// its disk copy for it. options: { hash, viaDisk, settleMs }
async function rebuild(blogID, options) {
  options = options || {};

  return hold(blogID, async function () {
    let viaDisk = false;

    if (await primary.usesS3(blogID)) {
      if (!options.viaDisk) {
        throw failure(
          "EONS3",
          "This blog is on S3, so its reads go by the index this would empty. Pass --via-disk to serve it from its disk copy while the index is rebuilt."
        );
      }

      if (await client.sIsMember(primary.DIRTY_KEY, blogID)) {
        throw failure(
          "ECONFLICT",
          "This blog's disk copy is behind S3, so it can't serve the blog meanwhile. Run scripts/storage/backfill-folder.js --blog " + blogID + " --apply first."
        );
      }

      await mirror.markBehind(blogID);
      await sleep(options.settleMs === undefined ? SETTLE_MS : options.settleMs);
      viaDisk = true;
    }

    const result = await backend.rebuildIndex(blogID, { hash: options.hash !== false });

    return Object.assign(result, { viaDisk: viaDisk });
  });
}

async function main() {
  const options = parse(process.argv.slice(2));
  const blogID = options.blogID;

  s3.assertConfigured();

  const blog = await promisify(Blog.get)({ id: blogID });

  if (!blog) usage("No blog " + blogID);

  console.log("Now:", await File.totals(blogID));

  if (!options.apply) {
    // No need to hash just to count
    report("From S3:", await count(blogID, { hash: false }));
    if (await primary.usesS3(blogID)) console.log("This blog is on S3: --apply needs --via-disk (see the header)");
    console.log("Dry run: pass --apply to rebuild the index");
    return;
  }

  const { viaDisk, ...result } = await rebuild(blogID, options);

  report("Rebuilt:", result);

  if (viaDisk) {
    console.log(
      "Served from its disk copy until the next hourly reconcile checks S3 against it and puts it back on S3 " +
        "(or run scripts/storage/backfill-folder.js --blog " + blogID + " --apply now)."
    );
  }
}

if (require.main === module) {
  main().then(
    function () {
      process.exit(0);
    },
    function (err) {
      console.error(err.code === "EONS3" || err.code === "ECONFLICT" ? err.message : err);
      process.exit(1);
    }
  );
}

module.exports = { rebuild, count };
