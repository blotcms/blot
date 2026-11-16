// Deletes the avatars a blog no longer uses (#2760). Saving a new avatar
// used to leave the previous file under {blogID}/_avatars/ in the storage
// bucket; the dashboard now deletes it, and this removes the ones left.
//
//   node scripts/storage/replaced-avatars.js [<blogID>] [--apply] [--from <blogID>]
//
// For each blog (or the one named), it lists the objects under
// {blogID}/_avatars/ and deletes those other than the one blog.avatar names,
// by exact key. An object less than a day old is kept, in case a save is
// still in progress. A blog whose avatar is set to something which is not a
// file under its _avatars/ is skipped and listed, since the current file
// can't be told from the rest.
//
// Without --apply it only reports the counts and bytes. Safe to rerun, and
// resumable: blogs are taken in sorted order and each is printed as it is
// done, so after an interruption pass the last one printed to --from.

const Blog = require("models/blog");
const s3 = require("storage/s3");
const avatar = require("dashboard/site/save/avatar");

const DAY = 24 * 60 * 60 * 1000;

function usage(message) {
  if (message) console.error(message + "\n");

  console.error(
    "Usage: node scripts/storage/replaced-avatars.js [<blogID>] [--apply] [--from <blogID>]"
  );
  process.exit(2);
}

function parse(argv) {
  const options = { apply: false, from: null, blog: null };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") options.apply = true;
    else if (argv[i] === "--from" && argv[i + 1]) options.from = argv[++i];
    else if (!argv[i].startsWith("--") && !options.blog) options.blog = argv[i];
    else usage("Unknown argument: " + argv[i]);
  }

  return options;
}

// Counts the replaced avatars of a blog, and with apply deletes them.
// Resolves { skipped: true } when the blog's avatar can't be matched to a
// file, otherwise { count, bytes, kept } where kept is the number of
// replaced files held back for being less than a day old.
async function removeReplaced(blogID, apply, now = Date.now()) {
  const blog = await Blog.get({ id: blogID });

  if (!blog) return { count: 0, bytes: 0, kept: 0 };

  const current = avatar.relPathOf(blogID, blog.avatar);

  if (blog.avatar && !current) return { skipped: true };

  const prefix = blogID + "/" + avatar.folder + "/";
  const keys = [];
  const result = { count: 0, bytes: 0, kept: 0 };

  for await (const entry of s3.listEntries(prefix)) {
    // listEntries yields objects, not prefixes, without a delimiter
    if (!entry.key || entry.key.endsWith("/")) continue;
    if (current && entry.key === blogID + "/" + current) continue;

    if (now - new Date(entry.modified).getTime() < DAY) {
      result.kept++;
      continue;
    }

    keys.push(entry.key);
    result.count++;
    result.bytes += entry.size || 0;
  }

  if (apply) {
    for (let i = 0; i < keys.length; i += 1000)
      await s3.deleteKeys(keys.slice(i, i + 1000));
  }

  return result;
}

async function main() {
  const options = parse(process.argv.slice(2));
  const all = (await Blog.getAllIDs()).sort();
  const ids = options.blog
    ? [options.blog]
    : all.filter((id) => !options.from || id >= options.from);
  const totals = { blogs: 0, count: 0, bytes: 0, kept: 0 };
  const skipped = [];
  const verb = options.apply ? "deleted" : "would delete";

  for (const blogID of ids) {
    const result = await removeReplaced(blogID, options.apply);

    if (result.skipped) {
      skipped.push(blogID);
      continue;
    }

    if (!result.count && !result.kept) continue;

    totals.blogs++;
    totals.count += result.count;
    totals.bytes += result.bytes;
    totals.kept += result.kept;

    console.log(
      blogID +
        ": " +
        verb +
        " " +
        result.count +
        " files, " +
        result.bytes +
        " bytes" +
        (result.kept ? ", kept " + result.kept + " under a day old" : "")
    );
  }

  console.log(
    "Total of " +
      ids.length +
      " blogs: " +
      verb +
      " " +
      totals.count +
      " files, " +
      totals.bytes +
      " bytes, in " +
      totals.blogs +
      " blogs; kept " +
      totals.kept +
      " under a day old"
  );

  if (skipped.length)
    console.log(
      "Skipped, avatar is not a file under _avatars/:\n" + skipped.join("\n")
    );
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

module.exports = { removeReplaced };
