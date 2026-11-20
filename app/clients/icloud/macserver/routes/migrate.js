import fs from "fs-extra";
import { join } from "path";
import { iCloudDriveDirectory } from "../config.js";
import { refresh, rootOf } from "../blogFolder.js";
import sharePermission from "../util/sharePermission.js";
import { setupBlog, shareInfo } from "./setup.js";
import leaveFolder from "../util/leaveFolder.js";
import finderLimiter from "../util/finderLimiter.js";
import { watch, unwatch } from "../watcher/index.js";
import requestResync from "../httpClient/resync.js";
import status from "../httpClient/status.js";
import clfdate from "../util/clfdate.js";

// Moves one blog from the old layout (blog_<id> is the shared folder, renamed
// by setup) to the nested one (blogFolder.js, #2874), so its folder follows
// the owner's renames. A renamed share never follows them again, so this
// leaves the share and opens its link again: it comes back under the owner's
// current name, and setup nests it.
//
// Run by scripts/icloud/migrate-nested.js, one blog at a time. It answers
// once done, with { folderName } or an error.
//
// Leaving is the one step that can't be taken back, so it happens only when
// the share is still Blot's to rejoin: shared with Blot, Blot may make
// changes, and the same share (by its collaboration ID) must come back.
// Unlike a setup, nothing is copied into the folder afterwards: Blot is asked
// for a resync from iCloud instead, so the owner's latest files win.
const collaborationID = async (path) => {
  try {
    return JSON.parse(await shareInfo(path)).CollaborationIdentifier || null;
  } catch {
    return null;
  }
};

export default async (req, res) => {
  const blogID = req.header("blogID");
  const sharingLink = req.header("sharingLink");

  if (!blogID || !/^blog_[a-zA-Z0-9]+$/.test(blogID))
    return res.status(400).send("Invalid blogID");
  if (!sharingLink) return res.status(400).send("Missing sharingLink");

  const container = join(iCloudDriveDirectory, blogID);
  if (!(await fs.pathExists(container)))
    return res.status(404).send("No folder for this blog");

  const layout = await refresh(blogID);
  if (layout.nested) return res.status(409).send("Already nested");

  const permission = await sharePermission(container, { attempts: 2 });
  if (permission !== "readWrite")
    return res.status(409).send(`Share permission is ${permission}`);

  const before = await collaborationID(container);
  if (!before || before === "(none)")
    return res.status(409).send("Not a shared folder");

  console.log(clfdate(), `Migrating ${blogID} to the nested layout`);

  // Not watched meanwhile: the folder is briefly gone, which the watcher
  // would otherwise report to Blot as deleted
  await unwatch(blogID);

  // Leave the share first: opening a link to a share this Mac is still in
  // brings no new folder for setup to find. Through the Finder queue setup
  // uses too, so the two never drive Finder at once
  let result;
  try {
    await finderLimiter.schedule(() =>
      leaveFolder(container, { root: iCloudDriveDirectory })
    );
    result = await setupBlog(blogID, sharingLink, (stage) =>
      console.log(clfdate(), `Migrating ${blogID}: ${stage}`)
    );
  } catch (error) {
    console.error(
      clfdate(),
      `MIGRATION FAILED for ${blogID}, its folder may be gone:`,
      error.message
    );
    return res.status(500).send(`Rejoin failed: ${error.message}`);
  }

  // Setup takes the first new folder to appear. Only when it is the same
  // share does the blog sync again: another folder must never be resynced
  // into this blog, which could remove or replace its files. It stays
  // unwatched for the maintainer to look at
  let after = null;
  try {
    after = await collaborationID(rootOf(blogID));
  } catch {
    // no folder: after stays null
  }
  if (after !== before) {
    console.error(
      clfdate(),
      `MIGRATION for ${blogID} came back with another share (${before} -> ${after}): not watched, not resynced`
    );
    return res
      .status(500)
      .send(`Another share came back (${after}); ${blogID} is left unwatched`);
  }

  await watch(blogID);
  await status(blogID, { folderName: result.folderName }).catch((error) =>
    console.error(clfdate(), `folderName for ${blogID}:`, error.message)
  );
  requestResync(blogID, "migrated to the nested layout").catch((error) =>
    console.error(clfdate(), `resync for ${blogID}:`, error.message)
  );

  console.log(clfdate(), `Migrated ${blogID} as "${result.folderName}"`);
  res.json({ folderName: result.folderName, sameShare: true });
};
