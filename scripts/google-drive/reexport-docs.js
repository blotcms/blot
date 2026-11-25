// Exports Google Docs again from Drive and republishes them, one at a time,
// each under its blog's folder lock, as the hot doc poller does for an edit
// (serviceAccount/hotDocPoller.js applyChange). A Doc that can't be published
// alone (renamed, moved, a sibling with its name) falls back to the blog's
// full sync, as an edit would. Its applied record is made stale first, so
// that sync sees a change and exports it too, instead of finding the copy
// it holds current.
//
// --comments: only Docs whose copy in the blog folder still holds comments,
// written before the export removed them (#2975). That copy is served as is,
// so their comments were readable by anyone with its URL.
//
// Writes only what a sync writes. Safe to run again: a re-export of an
// unchanged Doc gives the same file.
//
// Usage:
//   node scripts/google-drive/reexport-docs.js --comments            # dry run
//   node scripts/google-drive/reexport-docs.js --comments --apply
//   node scripts/google-drive/reexport-docs.js --blog blog_x --apply  # every Doc on one blog
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const commentsOnly = args.includes("--comments");
const onlyBlog = args.includes("--blog")
  ? args[args.indexOf("--blog") + 1]
  : null;

const database = require("clients/google-drive/database");
const folder = require("storage/folder");
const hotDocPoller = require("clients/google-drive/serviceAccount/hotDocPoller");

const HAS_COMMENT = /id="cmnt_ref\d+"/;

async function main() {
  if (!commentsOnly && !onlyBlog)
    throw new Error("Pass --comments, or --blog <id> to re-export one blog");
  if (args.includes("--blog") && !/^blog_/.test(onlyBlog || ""))
    throw new Error("--blog needs a blog id, e.g. --blog blog_abc");

  const accounts = [];
  await database.blog.iterate(async (blogID, account) => {
    if (onlyBlog && blogID !== onlyBlog) return;
    if (account?.folderId && account?.serviceAccountId && !account.preparing)
      accounts.push({ blogID, account });
  });

  const counts = { docs: 0, applied: 0, failed: 0, other: {} };
  // Blogs whose Doc fell back to a full sync, which runs in this process
  // without being awaited: wait for each before exiting
  const syncing = new Set();

  for (const { blogID, account } of accounts) {
    const paths = [];
    try {
      for await (const path of folder.walk(blogID, "/"))
        if (/\.gdoc$/i.test(path)) paths.push(path);
    } catch (err) {
      console.log(blogID, "could not list the folder:", err.message);
      continue;
    }

    const mapping = database.folder(account.folderId, blogID);

    for (const path of paths) {
      if (commentsOnly) {
        let html = "";
        try {
          html = (await folder.read(blogID, path)).toString("utf8");
        } catch (err) {}
        if (!HAS_COMMENT.test(html)) continue;
      }

      const fileId = await mapping.getByPath(path);
      if (!fileId) {
        console.log(blogID, path, "is not mapped to a Drive file, skipped");
        continue;
      }

      counts.docs += 1;
      if (!apply) {
        console.log("Would re-export", blogID, path);
        continue;
      }

      // A record with no SHA-1 is never trusted (database/folder.js); an
      // applied single-Doc export writes a fresh one
      await mapping.setApplied(fileId, {
        modifiedTime: new Date(0).toISOString(),
      });

      let result;
      try {
        result = await hotDocPoller.applyChange({
          blogID,
          serviceAccountId: account.serviceAccountId,
          fileId,
          folderId: account.folderId,
        });
      } catch (err) {
        // Its applied record is stale, so the blog's next sync exports it
        console.log("Failed", blogID, path, err.message);
        counts.failed += 1;
        continue;
      }
      console.log("Re-exported", blogID, path, result);
      if (result === "full-sync") syncing.add(blogID);
      if (result === "applied") counts.applied += 1;
      else counts.other[result] = (counts.other[result] || 0) + 1;
    }
  }

  for (const blogID of syncing) {
    console.log("Waiting for the full sync of", blogID);
    await waitForSync(blogID);
  }

  console.log(
    apply
      ? `Re-exported ${counts.applied} of ${counts.docs} Docs, ${counts.failed} failed; others: ${JSON.stringify(counts.other)}`
      : `Dry run: would re-export ${counts.docs} Docs. Run again with --apply.`
  );
}

// Until the blog's folder lock is free for a few checks in a row: the full
// sync starts a moment after applyChange returns, and may run twice (a
// follow-up). Gives up after 15 minutes; the follow-up armed in Redis then
// runs in the app.
async function waitForSync(blogID) {
  const deadline = Date.now() + 15 * 60 * 1000;
  let free = 0;
  while (free < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    free = (await hotDocPoller.isFolderLocked(blogID)) ? 0 : free + 1;
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
