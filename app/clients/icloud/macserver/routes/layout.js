import fs from "fs-extra";
import { join } from "path";
import { iCloudDriveDirectory } from "../config.js";
import { refresh } from "../blogFolder.js";
import sharePermission from "../util/sharePermission.js";
import clfdate from "../util/clfdate.js";

// Read-only: a blog's folder layout and share, for the migration's dry run
// (scripts/icloud/migrate-nested.js). Changes nothing.
export default async (req, res) => {
  const blogID = req.header("blogID");
  if (!blogID || !/^blog_[a-zA-Z0-9]+$/.test(blogID))
    return res.status(400).send("Invalid blogID");

  try {
    const container = join(iCloudDriveDirectory, blogID);
    if (!(await fs.pathExists(container)))
      return res.json({ exists: false, nested: false });

    const layout = await refresh(blogID);
    const root = layout.nested ? layout.root : container;
    res.json({
      exists: true,
      nested: layout.nested,
      name: layout.name,
      permission: root ? await sharePermission(root, { attempts: 1 }) : null,
    });
  } catch (error) {
    console.error(clfdate(), `layout failed for ${blogID}:`, error.message);
    res.status(500).send(error.message);
  }
};
