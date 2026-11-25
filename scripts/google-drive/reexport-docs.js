// Exports Google Docs again from Drive and republishes them, one at a time,
// as the hot doc poller does for an edit (serviceAccount/hotDocPoller.js
// applyChange): the sync applies the Doc's directory under the blog's folder
// lock and exports the Doc whatever its modifiedTime says. A Doc the
// directory's listing doesn't find falls back to the blog's full sync, as an
// edit would. Its applied record is made stale first, so that sync sees a
// change and exports it too. A blog whose folder is busy is tried again for
// up to a minute.
//
// --comments: only Docs whose copy in the blog folder still holds comments,
// written before the export removed them (#2975). That copy is served as is,
// so their comments were readable by anyone with its URL.
//
// --zip: every Doc still held as a zip export (HTML), on every Drive blog,
// so it is fetched through the Docs API and rendered from its JSON (#2975).
// Then, for each Doc held as JSON whose post is built from it, the zip
// export's images (image1.png and so on) still in its _assets directory are
// removed, under the folder lock: only once the post no longer uses them,
// and only names the Doc's image record doesn't list. A rerun cleans what an
// earlier one couldn't.
// A Doc the API can't give whole (a positioned image, a drawing) stays a zip
// export and is listed again on the next run; so is an HTML file someone
// named .gdoc, which is downloaded again unchanged.
//
// Writes only what a sync writes. Safe to run again: a re-export of an
// unchanged Doc gives the same file.
//
// Usage:
//   node scripts/google-drive/reexport-docs.js --comments            # dry run
//   node scripts/google-drive/reexport-docs.js --comments --apply
//   node scripts/google-drive/reexport-docs.js --blog blog_x --apply  # every Doc on one blog
//   node scripts/google-drive/reexport-docs.js --zip --apply          # every zip export
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const commentsOnly = args.includes("--comments");
const zipOnly = args.includes("--zip");
const onlyBlog = args.includes("--blog")
  ? args[args.indexOf("--blog") + 1]
  : null;

const database = require("clients/google-drive/database");
const folder = require("storage/folder");
const hotDocPoller = require("clients/google-drive/serviceAccount/hotDocPoller");
const docImages = require("clients/google-drive/database/docImages");
const { isBuilt } = require("clients/google-drive/util/fetchDoc");
const assets = require("storage/assets");
const hash = require("helper/hash");
const establishSyncLock = require("sync/establishSyncLock");

// JSON from the Docs API starts with "{", a zip export with "<"
const kindOf = (text) =>
  text.startsWith("{") ? "json" : text.startsWith("<") ? "zip" : null;

// Removes the zip export's images a JSON Doc's post no longer uses.
// Resolves to how many it removed.
async function cleanZipImages(blogID, fileId, path) {
  let text;
  try {
    text = (await folder.read(blogID, path)).toString("utf8").trimStart();
  } catch (err) {
    return 0;
  }
  if (kindOf(text) !== "json") return 0;
  const { revisionId } = JSON.parse(text);
  if (!(await isBuilt(blogID, fileId, path, revisionId))) return 0;

  const assetDir = "_assets/" + hash(path);
  const { done, folder: locked } = await establishSyncLock(blogID);
  try {
    return await locked.run(async () => {
      const record = await docImages.get(blogID, fileId);
      if (record.dir && record.dir !== assetDir) return 0;
      const used = new Set(Object.values(record.images || {}));
      let removed = 0;
      for (const name of await assets.list(blogID, assetDir))
        if (!used.has(name)) {
          await assets.remove(blogID, assetDir + "/" + name);
          removed += 1;
        }
      return removed;
    });
  } finally {
    await done();
  }
}

const HAS_COMMENT = /id="cmnt_ref\d+"/;

async function main() {
  if (!commentsOnly && !zipOnly && !onlyBlog)
    throw new Error(
      "Pass --comments, --zip, or --blog <id> to re-export one blog"
    );
  if (args.includes("--blog") && !/^blog_/.test(onlyBlog || ""))
    throw new Error("--blog needs a blog id, e.g. --blog blog_abc");

  const accounts = [];
  await database.blog.iterate(async (blogID, account) => {
    if (onlyBlog && blogID !== onlyBlog) return;
    if (account?.folderId && account?.serviceAccountId && !account.preparing)
      accounts.push({ blogID, account });
  });

  const counts = {
    docs: 0,
    applied: 0,
    failed: 0,
    stayedZip: 0,
    cleaned: 0,
    other: {},
  };
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
      let kind = null;
      if (commentsOnly || zipOnly) {
        let html = "";
        try {
          html = (await folder.read(blogID, path)).toString("utf8");
        } catch (err) {}
        if (commentsOnly && !HAS_COMMENT.test(html)) continue;
        kind = kindOf(html.trimStart());
        // An empty placeholder has nothing to fetch through the API
        if (zipOnly && !kind) continue;
      }
      const fileId = await mapping.getByPath(path);
      if (!fileId) {
        console.log(blogID, path, "is not mapped to a Drive file, skipped");
        continue;
      }

      if (zipOnly && kind === "json") {
        if (apply) {
          const removed = await cleanZipImages(blogID, fileId, path).catch(
            (err) => {
              console.log("Cleaning failed", blogID, path, err.message);
              return 0;
            }
          );
          if (removed)
            console.log("Removed", removed, "zip images", blogID, path);
          counts.cleaned += removed;
        }
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
        for (let tries = 0; tries < 30; tries++) {
          result = await hotDocPoller.applyChange({
            blogID,
            serviceAccountId: account.serviceAccountId,
            fileId,
            folderId: account.folderId,
          });
          if (result !== "locked") break;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      } catch (err) {
        // Its applied record is stale, so the blog's next sync exports it
        console.log("Failed", blogID, path, err.message);
        counts.failed += 1;
        continue;
      }
      console.log("Re-exported", blogID, path, result);
      // Fetched through the API (or fell back to the zip export: an image
      // fetch failed, or the Doc holds something the API can't give)
      if (zipOnly && result === "applied") {
        let now = "";
        try {
          now = (await folder.read(blogID, path)).toString("utf8").trimStart();
        } catch (err) {}
        if (kindOf(now) !== "json") {
          counts.stayedZip += 1;
          console.log("Still a zip export", blogID, path);
          continue;
        }
        const removed = await cleanZipImages(blogID, fileId, path).catch(
          () => 0
        );
        counts.cleaned += removed;
      }
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
      ? `Re-exported ${counts.applied} of ${counts.docs} Docs, ${counts.failed} failed, ${counts.stayedZip} still zip exports, ${counts.cleaned} zip images removed; others: ${JSON.stringify(counts.other)}`
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
