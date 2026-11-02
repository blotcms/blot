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
// kept by a move into the folder is lost.

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

// What a listing would put in the index, without writing it
async function count(blogID, options) {
  const counts = { files: 0, dirs: new Set(), bytes: 0 };

  for await (const record of backend.indexRecords(blogID, options)) {
    const parts = record.path.split("/").slice(1);

    // Every ancestor is a directory, whether it has a marker or not
    for (let i = 1; i < parts.length; i++) counts.dirs.add("/" + parts.slice(0, i).join("/"));

    if (record.type === "dir") {
      counts.dirs.add(record.path);
    } else {
      counts.files += 1;
      counts.bytes += record.size;
    }
  }

  return { files: counts.files, dirs: counts.dirs.size, bytes: counts.bytes };
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
    console.log("From S3:", await count(blogID, { hash: false }));
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

  console.log("Rebuilt:", result);
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
