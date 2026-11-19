import { join } from "path";
import { iCloudDriveDirectory } from "../config.js";

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

const extractPathInBlogDirectory = (filePath) => {
  if (!filePath.startsWith(iCloudDriveDirectory)) {
    return null;
  }
  const relativePath = filePath.replace(`${iCloudDriveDirectory}/`, "");
  const [, ...restPath] = relativePath.split("/");
  return restPath.join("/");
};

const validActions = ["upload", "remove", "mkdir"];

const assertValidAction = (action) => {
  if (!validActions.includes(action)) {
    throw new Error(`Invalid action: ${action}`);
  }
};

const buildBlogPath = (blogID, pathInBlogDirectory) =>
  join(iCloudDriveDirectory, blogID, pathInBlogDirectory);

export {
  extractBlogID,
  extractPathInBlogDirectory,
  validActions,
  assertValidAction,
  buildBlogPath,
};
