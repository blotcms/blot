import fs from "fs-extra";
import { join } from "path";
import { iCloudDriveDirectory } from "../config.js";
import { refresh, rootOf } from "../blogFolder.js";
import sharePermission from "../util/sharePermission.js";
import { setupBlog, shareInfo } from "./setup.js";
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

  let result;
  try {
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

  const after = await collaborationID(rootOf(blogID));
  const sameShare = after === before;
  if (!sameShare)
    console.error(
      clfdate(),
      `MIGRATION for ${blogID} came back with another share: ${before} -> ${after}`
    );

  await watch(blogID);
  await status(blogID, { folderName: result.folderName }).catch((error) =>
    console.error(clfdate(), `folderName for ${blogID}:`, error.message)
  );
  requestResync(blogID, "migrated to the nested layout").catch((error) =>
    console.error(clfdate(), `resync for ${blogID}:`, error.message)
  );

  console.log(
    clfdate(),
    `Migrated ${blogID} as "${result.folderName}"${sameShare ? "" : " (another share!)"}`
  );
  res.json({ folderName: result.folderName, sameShare });
};
