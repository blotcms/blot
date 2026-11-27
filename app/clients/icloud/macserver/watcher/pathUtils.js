import { join } from "path";
import { iCloudDriveDirectory } from "../config.js";
import { locate, rootOf } from "../blogFolder.js";

const extractBlogID = (filePath) => {
  if (!filePath.startsWith(iCloudDriveDirectory)) {
    return null;
  }
  const relativePath = filePath.replace(`${iCloudDriveDirectory}/`, "");
  const [blogID] = relativePath.split("/");

  if (!blogID || !blogID.startsWith("blog_")) {
    return null;
  }

  return blogID;
};

// The path inside the blog's shared folder, the folder inside blog_<id>
// (blogFolder.js). "" for the folder itself, or for anything else inside
// blog_<id>; null outside every blog folder.
const extractPathInBlogDirectory = (filePath) => {
  const at = locate(filePath);
  return at ? at.path : null;
};

const validActions = ["upload", "remove", "mkdir"];

const assertValidAction = (action) => {
  if (!validActions.includes(action)) {
    throw new Error(`Invalid action: ${action}`);
  }
};

const buildBlogPath = (blogID, pathInBlogDirectory) =>
  join(rootOf(blogID), pathInBlogDirectory);

export {
  extractBlogID,
  extractPathInBlogDirectory,
  validActions,
  assertValidAction,
  buildBlogPath,
};
