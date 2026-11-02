// Rebuilds a blog's folder index (models/file) from a full listing of its
// folder in the storage bucket, {blogID}/folder/. Only for blogs whose folder
// is in S3, which none is yet (#2258 Phase C): for any other blog the listing
// is empty and the index would be emptied.
//
//   node scripts/storage/rebuild-file-index.js <blogID> [--apply] [--no-hash]
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
const Sync = require("sync");
const backend = require("storage/folder/s3");
const { promisify } = require("util");

function usage(message) {
  if (message) console.error(message + "\n");

  console.error("Usage: node scripts/storage/rebuild-file-index.js <blogID> [--apply] [--no-hash]");
  process.exit(2);
}

function parse(argv) {
  const options = { apply: false, hash: true };

  for (const arg of argv) {
    if (arg === "--apply") options.apply = true;
    else if (arg === "--no-hash") options.hash = false;
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
    console.log("Dry run: pass --apply to rebuild the index");
    return;
  }

  let result;

  await new Promise(function (resolve, reject) {
    Sync(blogID, function (err, folder, done) {
      if (err) return reject(err);

      backend.rebuildIndex(blogID, { hash: options.hash }).then(
        function (counts) {
          result = counts;
          done(null, function (err) {
            if (err) reject(err);
            else resolve();
          });
        },
        function (err) {
          done(err, function () {
            reject(err);
          });
        }
      );
    });
  });

  report("Rebuilt:", result);
}

main().then(
  function () {
    process.exit(0);
  },
  function (err) {
    console.error(err);
    process.exit(1);
  }
);
