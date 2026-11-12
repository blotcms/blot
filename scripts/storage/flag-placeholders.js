// Flags the placeholders written before placeholders were flagged (#2673).
// Until then Blot wrote an empty file wherever it could not download one
// (over the size limit, a Dropbox .paper file, a Google App file), with
// nothing to tell it from a file which really is empty. Now storage/folder's
// writePlaceholder flags each one, and an unflagged empty file counts as
// really empty, so it is uploaded on the next reset to a remote.
//
// For each Dropbox, Google Drive and iCloud blog with an unflagged empty file,
// this runs the client's own resync, under the blog's sync lock. A resync
// revisits every placeholder through the normal download path, which writes
// a flagged placeholder, downloads the real bytes if it now can, or leaves a
// file which really is empty as it is. Safe to rerun: a blog left with no
// unflagged empty file is skipped. Blogs on other clients are left alone, as
// those clients never wrote placeholders.
//
//   node scripts/storage/flag-placeholders.js [--apply] [--blog <blogID>]
//
// Without --apply it only counts the unflagged empty files of each blog.
// A blog which is locked (a sync is running) is skipped and listed, to retry
// with --blog.

const Blog = require("models/blog");
const File = require("models/file");
const establishSyncLock = require("sync/establishSyncLock");

const CLIENTS = ["dropbox", "google-drive", "icloud"];

// What resync resolves to for an iCloud blog whose setup isn't complete
const SKIPPED = "skipped";

function usage(message) {
  if (message) console.error(message + "\n");

  console.error(
    "Usage: node scripts/storage/flag-placeholders.js [--apply] [--blog <blogID>]"
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

// The paths of the folder's empty files without a flag, from the index
async function unflaggedEmpty(blogID) {
  const found = [];
  const pending = ["/"];

  while (pending.length) {
    const dir = pending.shift();

    for await (const page of File.pages(blogID, dir)) {
      for (const entry of page) {
        const path = dir === "/" ? "/" + entry.name : dir + "/" + entry.name;

        if (entry.type === "dir") pending.push(path);
        else if (entry.size === 0 && !entry.flags) found.push(path);
      }
    }
  }

  return found;
}

// Runs the blog's client's resync, which flags its placeholders
async function resync(blog, publish, update) {
  if (blog.client === "dropbox") {
    return require("clients/dropbox/sync/reset-to-blot")(
      blog.id,
      publish,
      update
    );
  }

  if (blog.client === "google-drive") {
    return require("clients/google-drive/sync/resetFromDrive")(
      blog.id,
      publish,
      update
    );
  }

  if (blog.client === "icloud") {
    const account = await require("clients/icloud/database").get(blog.id);

    if (!account || account.setupComplete !== true) return SKIPPED;

    return require("clients/icloud/sync/fromiCloud")(blog.id, publish, update);
  }
}

// Resolves to the resync's summary, SKIPPED, or a falsy value if the resync
// did not finish walking the folder
async function refetch(blog) {
  const { folder, done } = await establishSyncLock(blog.id);

  try {
    return await resync(blog, folder.status, folder.update);
  } finally {
    await done();
  }
}

// Why a resync's result doesn't show every file was revisited, or null
function incompleteReason(summary) {
  if (summary === SKIPPED) return "setup is not complete";
  if (!summary) return "the resync did not finish walking the folder";
  if (summary.failed > 0) {
    return (
      summary.failed +
      " file" +
      (summary.failed === 1 ? "" : "s") +
      " failed" +
      (summary.firstError ? " (" + summary.firstError + ")" : "")
    );
  }
  return null;
}

async function main() {
  const options = parse(process.argv.slice(2));
  const ids = options.blog
    ? [options.blog]
    : (await Blog.getAllIDs()).slice().sort();
  const totals = { blogs: 0, before: 0, after: 0 };
  const skipped = [];
  const failed = [];

  console.log(
    (options.apply ? "Flagging placeholders in " : "Dry run over ") +
      ids.length +
      " blogs"
  );

  for (const blogID of ids) {
    const blog = await Blog.get({ id: blogID });

    if (!blog || blog.isDisabled || CLIENTS.indexOf(blog.client) === -1)
      continue;

    const before = await unflaggedEmpty(blogID);

    if (!before.length) continue;

    totals.blogs++;
    totals.before += before.length;

    if (!options.apply) {
      console.log(blogID, blog.client, before.length, "unflagged empty files");
      continue;
    }

    let summary;

    try {
      summary = await refetch(blog);
    } catch (err) {
      if (err && err.code === "ELOCKED") skipped.push(blogID);
      else failed.push(blogID + " " + ((err && err.message) || err));
      continue;
    }

    const after = await unflaggedEmpty(blogID);
    const reason = incompleteReason(summary);

    // Only a resync which revisited every file shows that what is left
    // really is empty. Otherwise the blog is listed to retry.
    if (reason) {
      failed.push(
        blogID + " " + reason + ", " + after.length + " unflagged empty left"
      );
      continue;
    }

    totals.after += after.length;

    console.log(
      blogID,
      blog.client,
      before.length,
      "unflagged empty files,",
      after.length,
      "left (files which really are empty)"
    );
  }

  console.log(
    totals.before +
      " unflagged empty files in " +
      totals.blogs +
      " blogs" +
      (options.apply ? ", " + totals.after + " left after resyncing" : "")
  );

  if (skipped.length) console.log("Skipped, locked: " + skipped.join(" "));
  if (failed.length) {
    process.exitCode = 1;
    console.log("Incomplete, retry with --blog:\n" + failed.join("\n"));
  }
  if (!options.apply) console.log("Dry run: pass --apply to resync them");
}

if (require.main === module) {
  main().then(
    function () {
      process.exit(process.exitCode || 0);
    },
    function (err) {
      console.error(err);
      process.exit(1);
    }
  );
}

module.exports = { unflaggedEmpty, incompleteReason, SKIPPED };
