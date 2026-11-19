import { join } from "path";
import { iCloudDriveDirectory } from "../config.js";
import { removeLimiterForBlogID } from "../limiters.js";
import { forgetBlog } from "../pushedFiles.js";
import { unwatch } from "../watcher/index.js";
import clfdate from "../util/clfdate.js";
import leaveFolder from "../util/leaveFolder.js";
import finderLimiter from "../util/finderLimiter.js";

export default async (req, res) => {
  const blogID = req.header("blogID");

  if (!blogID) {
    console.error(clfdate(), "Missing blogID header for disconnect request");
    return res.status(400).send("Missing blogID header");
  }

  // ensure the blogID doesn't container any characters other than
  // letters, numbers and underscores
  if (!/^[a-zA-Z0-9_]+$/.test(blogID)) {
    console.error(
      clfdate(),
      `Invalid blogID for disconnect request: ${blogID}`
    );
    return res.status(400).send("Invalid blogID");
  }

  console.log(clfdate(), `Received disconnect request for blogID: ${blogID}`);

  // Stop syncing the blog, then take its shared folder off this Mac. Never
  // remove it recursively: that deletes the owner's files (util/leaveFolder.js)
  removeLimiterForBlogID(blogID);
  forgetBlog(blogID);

  try {
    await unwatch(blogID);
    await finderLimiter.schedule(() =>
      leaveFolder(join(iCloudDriveDirectory, blogID), {
        root: iCloudDriveDirectory,
      })
    );
  } catch (error) {
    console.error(clfdate(), `Failed to disconnect blogID ${blogID}:`, error);
    return res.status(500).send(error.message);
  }

  console.log(clfdate(), `Disconnected blogID: ${blogID}`);

  res.sendStatus(200);
};
