// Deletes the blog:<blogID>:ignored_files hashes which models/ignoredFiles
// kept (#2673). That model is gone: a file over the post size limit is now
// flagged POST_TOO_LARGE on its models/file record, and the other reasons
// (wrong type, public file) follow from the path and the blog's converters.
// Nothing reads or writes the hashes any more.
//
//   node scripts/storage/remove-ignored-files.js [--apply] [--blog <blogID>]
//
// Without --apply it only counts them. Safe to rerun: a blog without the
// hash is skipped. A key of another type is left alone and listed.

const Blog = require("models/blog");
const client = require("models/client");

function usage(message) {
  if (message) console.error(message + "\n");

  console.error(
    "Usage: node scripts/storage/remove-ignored-files.js [--apply] [--blog <blogID>]"
  );
  process.exit(2);
}

function parse(argv) {
  const options = { apply: false, blog: null };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") options.apply = true;
    else if (argv[i] === "--blog" && argv[i + 1]) options.blog = argv[++i];
    else usage("Unknown argument: " + argv[i]);
  }

  return options;
}

function key(blogID) {
  return "blog:" + blogID + ":ignored_files";
}

// The number of paths in the blog's hash, deleting it with apply. Resolves
// null when the blog has none, and the key's type when it isn't a hash.
async function removeFor(blogID, apply) {
  const type = await client.type(key(blogID));

  if (type === "none") return null;
  if (type !== "hash") return { type };

  const paths = await client.hLen(key(blogID));

  if (apply) await client.unlink(key(blogID));

  return { paths };
}

async function main() {
  const options = parse(process.argv.slice(2));
  const ids = options.blog ? [options.blog] : await Blog.getAllIDs();
  const totals = { blogs: 0, paths: 0 };
  const odd = [];

  for (const blogID of ids) {
    const result = await removeFor(blogID, options.apply);

    if (!result) continue;

    if (result.type) {
      odd.push(key(blogID) + " is a " + result.type);
      continue;
    }

    totals.blogs++;
    totals.paths += result.paths;
  }

  console.log(
    (options.apply ? "Removed " : "Found ") +
      totals.blogs +
      " ignored_files hashes holding " +
      totals.paths +
      " paths, of " +
      ids.length +
      " blogs"
  );

  if (odd.length) console.log("Left alone, not a hash:\n" + odd.join("\n"));
  if (!options.apply) console.log("Dry run: pass --apply to remove them");
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

module.exports = { removeFor, key };
