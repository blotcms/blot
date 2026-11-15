// Checks the natural-order sorted sets of the folder index (models/file,
// sorts.js) against each directory's hash, and with --apply rebuilds every
// one which is missing or differs. A directory gets its sets with its first
// new child, but code from before them changes directories without them
// while it runs beside the new code during a deploy, or after a rollback, so
// a set which exists is not trusted: every directory is compared, member by
// member. Safe to rerun, and to stop at any point: a set is rebuilt under
// another key and renamed into place.
//
//   node scripts/storage/add-file-index-sorts.js [--apply] [--blog <blogID>] [--order <name>]
//
// Run it once every unit runs the code which writes the sets, and again
// after any rollback to code from before them. Without --apply it only
// reports, with an estimate of the sets' memory under two values of Redis's
// zset-max-ziplist-value. With --apply each blog is held under its sync lock
// (sync/hold.js); a locked blog is skipped and listed, to retry with --blog.
// It is done when a run without --apply finds nothing missing or mismatched.

const Blog = require("models/blog");
const File = require("models/file");
const hold = require("sync/hold");

// zset-max-ziplist-entries, Redis's default, which production keeps
const ZIPLIST_ENTRIES = 128;

// Values of zset-max-ziplist-value to estimate for: Redis's default, and
// the one the plan in #2693 considers
const ZIPLIST_VALUES = [64, 250];

const PAUSE_MS = 2;

// A directory's set in bytes, as MEMORY USAGE reports it on Redis 6.2 (fitted
// to measurements; within a few per cent). A ziplist stores each member with
// a few bytes of header and its score; a skiplist adds a node, a dict entry
// and an allocation per member.
function estimate(found, limit) {
  if (!found.expected) return 0;

  var ziplist = found.expected <= ZIPLIST_ENTRIES && found.longest <= limit;

  return ziplist
    ? 64 + found.bytes + 4 * found.expected
    : 300 + found.bytes + 85 * found.expected;
}

function usage(message) {
  if (message) console.error(message + "\n");

  console.error(
    "Usage: node scripts/storage/add-file-index-sorts.js [--apply] [--blog <blogID>] [--order <name>]"
  );
  process.exit(2);
}

function parse(argv) {
  const options = { apply: false, blog: null, order: null };

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--apply") options.apply = true;
    else if (argv[i] === "--blog" && argv[i + 1]) options.blog = argv[++i];
    else if (argv[i] === "--order" && argv[i + 1]) options.order = argv[++i];
    else usage("Unknown argument " + argv[i]);
  }

  return options;
}

function megabytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

async function checkBlog(blogID, options, totals) {
  const counts = { dirs: 0, missing: 0, mismatched: 0 };

  for await (const found of File.checkSorts(blogID, {
    apply: options.apply,
    order: options.order,
  })) {
    counts.dirs++;
    totals.members += found.expected;

    ZIPLIST_VALUES.forEach(function (limit) {
      totals.bytes[limit] += estimate(found, limit);
    });

    if (found.state === "ok") continue;

    counts[found.state]++;
  }

  return counts;
}

async function main() {
  const options = parse(process.argv.slice(2));
  const ids = options.blog
    ? [options.blog]
    : (await Blog.getAllIDs()).slice().sort();
  const totals = {
    blogs: 0,
    dirs: 0,
    missing: 0,
    mismatched: 0,
    members: 0,
    bytes: {},
  };
  const skipped = [];

  ZIPLIST_VALUES.forEach(function (limit) {
    totals.bytes[limit] = 0;
  });

  console.log(
    (options.apply
      ? "Checking and rebuilding sorted sets for "
      : "Dry run over ") +
      ids.length +
      " blogs"
  );

  for (const blogID of ids) {
    let counts;

    try {
      counts = options.apply
        ? await hold(blogID, () => checkBlog(blogID, options, totals))
        : await checkBlog(blogID, options, totals);
    } catch (err) {
      if (err.code !== "ELOCKED") throw err;

      skipped.push(blogID);
      continue;
    }

    totals.blogs++;
    totals.dirs += counts.dirs;
    totals.missing += counts.missing;
    totals.mismatched += counts.mismatched;

    if (counts.missing || counts.mismatched) console.log(blogID, counts);

    await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
  }

  console.log(
    "Checked " +
      totals.dirs +
      " directories in " +
      totals.blogs +
      " blogs: " +
      totals.missing +
      " missing, " +
      totals.mismatched +
      " mismatched" +
      (options.apply ? ", now rebuilt" : "")
  );

  console.log(
    totals.members +
      " members; estimated size of the sets: " +
      ZIPLIST_VALUES.map(function (limit) {
        return (
          megabytes(totals.bytes[limit]) +
          " with zset-max-ziplist-value " +
          limit
        );
      }).join(", ")
  );

  if (skipped.length) console.log("Skipped, locked: " + skipped.join(" "));
  if (!options.apply) console.log("Dry run: pass --apply to rebuild them");
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
