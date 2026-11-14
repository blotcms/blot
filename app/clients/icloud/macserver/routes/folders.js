import fs from "fs-extra";
import { iCloudDriveDirectory } from "../config.js";

// The blog folders in iCloud Drive, for Blot's daily orphan sweep
// (clients/icloud/sweepOrphans.js). Only names: Blot decides which belong to
// a connected blog and asks /disconnect to remove the rest.
export default async (req, res) => {
  const entries = await fs.readdir(iCloudDriveDirectory, {
    withFileTypes: true,
  });

  res.json({
    blogIDs: entries
      .filter(
        (entry) => entry.isDirectory() && /^blog_[a-zA-Z0-9]+$/.test(entry.name)
      )
      .map((entry) => entry.name)
      .sort(),
  });
};
