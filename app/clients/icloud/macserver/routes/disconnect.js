import fs from "fs-extra";
import { join } from "path";
import { iCloudDriveDirectory } from "../config.js";
import { removeLimiterForBlogID } from "../limiters.js";
import { forgetBlog } from "../pushedFiles.js";
import { unwatch } from "../watcher/index.js";
import clfdate from "../util/clfdate.js";

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

  // remove the blogid folder and the limiter
  removeLimiterForBlogID(blogID);
  forgetBlog(blogID);

  try {
    await unwatch(blogID);
    await fs.remove(join(iCloudDriveDirectory, blogID));
  } catch (error) {
    console.error(clfdate(), `Failed to disconnect blogID ${blogID}:`, error);
    return res.status(500).send(error.message);
  }

  console.log(clfdate(), `Disconnected blogID: ${blogID}`);

  res.sendStatus(200);
};
