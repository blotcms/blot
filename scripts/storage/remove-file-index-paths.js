// Deletes the path sets of the folder index (models/file): each blog's
// sorted set of every path in its folder (blog:{blogID}:file:paths), which
// subtree queries read before they walked the directories' hashes instead.
// Nothing reads them now. Safe to rerun.
//
//   node scripts/storage/remove-file-index-paths.js [--apply] [--blog <blogID>]
//
// Run it once every unit runs code which no longer writes them: code from
// before still adds to a blog's set when it writes, so a run during a deploy
// leaves some behind. Without --apply it only counts them and their memory.
// It is done when a run without --apply counts none.

const Blog = require("models/blog");
const File = require("models/file");
const client = require("models/client");

const PAUSE_MS = 2;

function usage(message) {
  if (message) console.error(message + "\n");

  console.error(
    "Usage: node scripts/storage/remove-file-index-paths.js [--apply] [--blog <blogID>]"
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

// The bytes the blog's path set takes, or 0 if it has none. With apply, the
// set is deleted too.
async function removePaths(blogID, apply) {
  const pathsKey = File.key.paths(blogID);
  const bytes = (await client.memoryUsage(pathsKey)) || 0;

  if (bytes && apply) await client.del(pathsKey);

  return bytes;
}

async function main() {
  const options = parse(process.argv.slice(2));
  const ids = options.blog
    ? [options.blog]
    : (await Blog.getAllIDs()).slice().sort();
  let blogs = 0;
  let bytes = 0;

  console.log(
    (options.apply ? "Deleting path sets for " : "Dry run over ") +
      ids.length +
      " blogs"
  );

  for (const blogID of ids) {
    const found = await removePaths(blogID, options.apply);

    if (found) blogs++;
    bytes += found;

    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  }

  console.log(
    blogs +
      " path sets, " +
      (bytes / 1024 / 1024).toFixed(1) +
      " MiB" +
      (options.apply ? ", now deleted" : "")
  );

  if (!options.apply) console.log("Dry run: pass --apply to delete them");
}

module.exports = { removePaths };

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
