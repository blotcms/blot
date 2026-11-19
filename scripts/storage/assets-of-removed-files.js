// Deletes the {blogID}/_assets/<hash>/ directories whose source file is gone
// (#2760 item 4). A converter (docx, odt, rtf, gdoc, the images img converts,
// the Google Drive import) writes what it extracts from a file to
// _assets/<md5 of the file's path>/, and a reconversion of the same path
// overwrites it. Removing or renaming the file now deletes the directory
// (app/sync/update/removeConvertedAssets.js); this removes the ones left by
// removals before that.
//
//   node scripts/storage/assets-of-removed-files.js [blogID] [--apply] [--from <blogID>]
//
// For each blog (or the one given), it lists _assets/ and the blog's folder
// files ({blogID}/folder/ in the bucket). A directory is stale when its name
// matches the hash of no folder file under any form a converter could have
// hashed: the path as stored (leading slash, NFC), lowercased, NFD, and each
// without the leading slash. A directory whose newest object is under a day
// old is kept, in case its file is being written. A name which isn't a 32
// character hash isn't ours and is kept.
//
// A directory is also kept when a live entry of the blog, one of its
// templates or its settings mentions _assets/<hash>: the converters' cached
// results are keyed by the source's bytes, so before each path had its own
// directory a copy of a file was linked into the first copy's directory, which
// no file hashes to. A blog whose folder listing has no files is skipped and
// reported (its listing can't be trusted to match against).
//
// Without --apply nothing is written. With it, the transformer's cached
// results which name a directory are deleted first (so the next build
// converts again), then the objects found in the listing are deleted by exact
// key, 1000 at a time, never by prefix.
// Resumable: it prints the last blog it finished, and --from starts at a blog
// (inclusive). Rerunning is safe.

const Blog = require("models/blog");
const hash = require("helper/hash");
const s3 = require("storage/s3");
const { inUse, ASSET_REFERENCE } = require("storage/sweep/references");
const { removePointingAt } = require("storage/sweep/assetsCache");

const DAY = 24 * 60 * 60 * 1000;
const HASH = /^[a-f0-9]{32}$/;

function usage(message) {
  if (message) console.error(message + "\n");

  console.error(
    "Usage: node scripts/storage/assets-of-removed-files.js [blogID] [--apply] [--from <blogID>]"
  );
  process.exit(2);
}

function parse(argv) {
  const options = { apply: false, blog: null, from: null };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") options.apply = true;
    else if (argv[i] === "--from" && argv[i + 1]) options.from = argv[++i];
    else if (!argv[i].startsWith("--") && !options.blog) options.blog = argv[i];
    else usage("Unknown argument: " + argv[i]);
  }

  return options;
}

// Every hash a converter could have given the file at this path
function hashesOf(path, into) {
  const stripped = (p) => p.replace(/^\/+/, "");

  for (const base of [path, path.normalize("NFC"), path.normalize("NFD")]) {
    for (const cased of [base, base.toLowerCase()]) {
      into.add(hash(cased));
      into.add(hash(stripped(cased)));
    }
  }

  return into;
}

// The hashes of every file in the blog's folder, and how many files there are
async function folderHashes(blogID) {
  const prefix = blogID + "/folder/";
  const hashes = new Set();
  let files = 0;

  for await (const entry of s3.listEntries(prefix)) {
    // a directory marker is not a file
    if (entry.key.endsWith("/")) continue;

    files++;
    hashesOf("/" + entry.key.slice(prefix.length), hashes);
  }

  return { hashes, files };
}

// The blog's _assets/ directories: name -> { keys, bytes, newest }
async function directories(blogID) {
  const prefix = blogID + "/_assets/";
  const found = new Map();

  for await (const entry of s3.listEntries(prefix)) {
    const name = entry.key.slice(prefix.length).split("/")[0];

    // an object directly in _assets/, not in a directory
    if (!name || name === entry.key.slice(prefix.length)) continue;

    let directory = found.get(name);

    if (!directory) {
      directory = { keys: [], bytes: 0, newest: 0 };
      found.set(name, directory);
    }

    directory.keys.push(entry.key);
    directory.bytes += entry.size || 0;
    directory.newest = Math.max(
      directory.newest,
      entry.modified ? entry.modified.getTime() : 0
    );
  }

  return found;
}

// Finds a blog's stale directories and, with apply, deletes them. Resolves to
// { directories, stale, recent, referenced, objects, bytes, totalBytes,
// skipped }, where stale counts the directories deleted (or which would be),
// and objects and bytes their contents. now is for specs.
//
// Before a directory's objects go, so does every transformer cached result
// which names it, so the next build converts again.
async function cleanBlog(blogID, apply, now) {
  now = now || Date.now();

  const found = await directories(blogID);
  const result = {
    directories: found.size,
    stale: 0,
    recent: 0,
    referenced: 0,
    objects: 0,
    bytes: 0,
    totalBytes: 0,
    skipped: 0,
  };

  if (!found.size) return result;

  for (const directory of found.values()) result.totalBytes += directory.bytes;

  const { hashes: live, files } = await folderHashes(blogID);

  // Nothing to match against: not a blog with no files but a listing which
  // can't be trusted
  if (!files) {
    result.skipped = 1;
    return result;
  }

  const used = await inUse(blogID, ASSET_REFERENCE);
  const doomed = [];

  for (const [name, directory] of found) {
    if (!HASH.test(name) || live.has(name)) continue;

    if (used.has("_assets/" + name)) {
      result.referenced++;
      continue;
    }

    if (now - directory.newest < DAY) {
      result.recent++;
      continue;
    }

    result.stale++;
    result.objects += directory.keys.length;
    result.bytes += directory.bytes;
    doomed.push([name, directory]);
  }

  if (!apply || !doomed.length) return result;

  await removePointingAt(blogID, new Set(doomed.map(([name]) => name)));

  let batch = [];

  for (const [, directory] of doomed) {
    for (const key of directory.keys) {
      batch.push(key);

      if (batch.length >= 1000) {
        await s3.deleteKeys(batch);
        batch = [];
      }
    }
  }

  await s3.deleteKeys(batch);

  return result;
}

async function main() {
  const options = parse(process.argv.slice(2));
  let ids = options.blog ? [options.blog] : await Blog.getAllIDs();

  ids = ids.slice().sort();

  if (options.from) ids = ids.filter((id) => id >= options.from);

  const totals = {
    blogs: 0,
    directories: 0,
    stale: 0,
    recent: 0,
    referenced: 0,
    objects: 0,
    bytes: 0,
    totalBytes: 0,
    skipped: 0,
  };
  const verb = options.apply ? "deleted" : "would delete";
  let last = null;

  for (const blogID of ids) {
    const result = await cleanBlog(blogID, options.apply);

    last = blogID;
    totals.blogs++;
    for (const field of Object.keys(result)) totals[field] += result[field];

    if (result.skipped)
      console.log(
        blogID +
          ": SKIPPED, no files in its folder listing but " +
          result.directories +
          " _assets directories"
      );
    else if (result.stale || result.recent || result.referenced)
      console.log(
        blogID +
          ": " +
          verb +
          " " +
          result.stale +
          " of " +
          result.directories +
          " directories (" +
          result.objects +
          " objects, " +
          result.bytes +
          " bytes of " +
          result.totalBytes +
          "), kept " +
          result.recent +
          " under a day old, " +
          result.referenced +
          " still linked by an entry, template or setting"
      );
  }

  console.log(
    "Total over " +
      totals.blogs +
      " blogs: " +
      verb +
      " " +
      totals.stale +
      " of " +
      totals.directories +
      " directories (" +
      totals.objects +
      " objects, " +
      totals.bytes +
      " bytes of " +
      totals.totalBytes +
      "), kept " +
      totals.recent +
      " under a day old, " +
      totals.referenced +
      " still linked; skipped " +
      totals.skipped +
      " blogs"
  );
  if (last) console.log("Last blog done: " + last + " (resume with --from)");
  if (!options.apply) console.log("Dry run: pass --apply to delete them");
}

if (require.main === module) {
  main().then(
    function () {
      process.exit(0);
    },
    function (err) {
      console.error(err);
      process.exit(1);
    }
  );
}

module.exports = { cleanBlog, hashesOf };
