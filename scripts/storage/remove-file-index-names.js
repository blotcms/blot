// Deletes the names sets of the folder index (models/file): each
// directory's sorted set of child names in code-unit order, which listings
// read before the natural-order sorted sets replaced them (#2693, step 7).
// Nothing reads or writes them now. Safe to rerun.
//
//   node scripts/storage/remove-file-index-names.js [--apply] [--blog <blogID>]
//
// Run it once every unit runs code which no longer writes them. Without
// --apply it only counts them. Each blog's keys are named from its path set
// a page at a time (a file has no names set, and deleting a missing key
// costs little, as removeAll does), so no key pattern is scanned. It is done
// when a run without --apply counts none.

const Blog = require("models/blog");
const File = require("models/file");
const client = require("models/client");

const PAGE = 1000;
const PAUSE_MS = 2;

function usage(message) {
  if (message) console.error(message + "\n");

  console.error(
    "Usage: node scripts/storage/remove-file-index-names.js [--apply] [--blog <blogID>]"
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

// Counts (or, with apply, deletes) one page of names keys. EXISTS and DEL
// both resolve to how many of the keys there were.
function sweep(keys, apply) {
  return apply ? client.del(keys) : client.exists(keys);
}

async function removeNames(blogID, apply) {
  let found = await sweep([File.key.names(blogID, "/")], apply);
  let page = [];

  for await (const path of File.subtree(blogID, "/", { pageSize: PAGE })) {
    page.push(File.key.names(blogID, path));

    if (page.length === PAGE) {
      found += await sweep(page, apply);
      page = [];
    }
  }

  if (page.length) found += await sweep(page, apply);

  return found;
}

async function main() {
  const options = parse(process.argv.slice(2));
  const ids = options.blog
    ? [options.blog]
    : (await Blog.getAllIDs()).slice().sort();
  let blogs = 0;
  let found = 0;

  console.log(
    (options.apply ? "Deleting names sets for " : "Dry run over ") +
      ids.length +
      " blogs"
  );

  for (const blogID of ids) {
    const count = await removeNames(blogID, options.apply);

    if (count) blogs++;
    found += count;

    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  }

  console.log(
    found +
      " names sets in " +
      blogs +
      " blogs" +
      (options.apply ? ", now deleted" : "")
  );

  if (!options.apply) console.log("Dry run: pass --apply to delete them");
}

module.exports = { removeNames };

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
