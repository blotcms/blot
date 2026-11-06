// Gives every directory in the folder index (models/file) its names set, the
// sorted set of child names which lets a large directory be listed a page at
// a time (#2258 Phase D). A directory gets one with its first new name, so
// only directories nobody has added to since they arrived lack one; those
// are still listed correctly, by reading their hash whole, so this only
// makes them cheap to page. Safe to rerun: a directory with a names set is
// left alone.
//
//   node scripts/storage/add-file-index-names.js [--apply] [--blog <blogID>]
//
// Without --apply it only counts the directories without a names set. With
// --apply it adds them, each blog under its sync lock (sync/hold.js), since
// a remove between reading a directory and adding its names would leave a
// name with no record. A blog which is locked (a sync is running) is skipped
// and listed, to retry with --blog.

const Blog = require("models/blog");
const File = require("models/file");
const hold = require("sync/hold");

function usage(message) {
  if (message) console.error(message + "\n");

  console.error(
    "Usage: node scripts/storage/add-file-index-names.js [--apply] [--blog <blogID>]"
  );
  process.exit(2);
}

function parse(argv) {
  const options = { apply: false, blog: null };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") options.apply = true;
    else if (argv[i] === "--blog" && argv[i + 1]) options.blog = argv[++i];
    else usage("Unknown argument " + argv[i]);
  }

  return options;
}

async function main() {
  const options = parse(process.argv.slice(2));
  const ids = options.blog
    ? [options.blog]
    : (await Blog.getAllIDs()).slice().sort();
  const totals = { blogs: 0, dirs: 0, missing: 0, names: 0 };
  const skipped = [];

  console.log(
    (options.apply ? "Adding names sets for " : "Dry run over ") +
      ids.length +
      " blogs"
  );

  for (const blogID of ids) {
    let counts;

    try {
      counts = options.apply
        ? await hold(blogID, () =>
            File.addMissingNames(blogID, { apply: true })
          )
        : await File.addMissingNames(blogID);
    } catch (err) {
      if (err.code !== "ELOCKED") throw err;

      skipped.push(blogID);
      continue;
    }

    totals.blogs++;
    totals.dirs += counts.dirs;
    totals.missing += counts.missing;
    totals.names += counts.names;

    if (counts.missing) console.log(blogID, counts);
  }

  console.log(
    "Looked at " +
      totals.dirs +
      " directories in " +
      totals.blogs +
      " blogs: " +
      totals.missing +
      " without a names set, holding " +
      totals.names +
      " names" +
      (options.apply ? ", now added" : "")
  );

  if (skipped.length) console.log("Skipped, locked: " + skipped.join(" "));
  if (!options.apply) console.log("Dry run: pass --apply to add them");
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
