// Where each blog's shared folder is in iCloud Drive. There are two layouts:
//
//   old:    <iCloud Drive>/blog_<id>         the shared folder itself, which
//                                            setup renamed to the blog's ID
//   nested: <iCloud Drive>/blog_<id>/<name>  a plain folder of Blot's own,
//                                            holding the shared folder under
//                                            the owner's name, and a marker
//
// iCloud passes the owner's renames on to a participant's copy only while
// that copy keeps the owner's name: renaming it to blog_<id> cuts it off for
// good. Nested, the folder keeps its name and follows the owner's renames,
// and blog_<id> still keeps blogs with the same folder name apart ("Blog",
// "Blog 2"). See #2874.
//
// Everything that turns a blog and a path into a file on disk goes through
// rootOf(), which is synchronous (it reads a cache) so the many callers that
// build paths stay as they are. refresh() re-reads one blog's layout from
// disk: at startup, after setup or a migration nests a folder, and when the
// watcher sees something change inside blog_<id> but outside the folder (a
// rename).

import fs from "fs-extra";
import { join } from "path";
import { iCloudDriveDirectory } from "./config.js";
import clfdate from "./util/clfdate.js";

// Written into blog_<id> when a folder is nested there. Its presence, not the
// shape of the folder, decides the layout: an old blog folder may well hold
// just one subfolder of the owner's.
export const MARKER = ".blot-nested";

const BLOG_ID = /^blog_[a-zA-Z0-9]+$/;

// blogID -> absolute path of the shared folder, for nested blogs only
const nested = new Map();

export const containerPath = (blogID) => join(iCloudDriveDirectory, blogID);

// The shared folder: the folder inside blog_<id> for a nested blog, else
// blog_<id> itself
export const rootOf = (blogID) => nested.get(blogID) || containerPath(blogID);

export const isNested = (blogID) => nested.has(blogID);

// The owner's name for a nested blog's folder, or null
export const folderNameOf = (blogID) => {
  const root = nested.get(blogID);
  return root ? root.slice(containerPath(blogID).length + 1) : null;
};

// The folders in a nested blog's blog_<id>, the marker left out
const foldersIn = async (container) =>
  (await fs.readdir(container, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);

// Reads one blog's layout from disk. Resolves to { nested, root, name,
// renamedFrom }: renamedFrom is the folder's previous name when it changed
// since the last read. A nested blog_<id> holding no folder (the share was
// left or deleted) or more than one (not something Blot makes) keeps no
// root: rootOf() then points at blog_<id>, where the watcher finds no files
// of the owner's, rather than at a folder that may be the wrong one.
export const refresh = async (blogID) => {
  if (!BLOG_ID.test(blogID)) throw new Error(`Invalid blogID: ${blogID}`);
  const container = containerPath(blogID);
  const before = folderNameOf(blogID);

  if (!(await fs.pathExists(join(container, MARKER)))) {
    nested.delete(blogID);
    return { nested: false, root: container, name: null, renamedFrom: null };
  }

  const folders = await foldersIn(container);
  if (folders.length !== 1) {
    if (folders.length > 1)
      console.error(
        clfdate(),
        `blogFolder: ${blogID} holds ${folders.length} folders: ${folders.join(", ")}`
      );
    nested.delete(blogID);
    return { nested: true, root: null, name: null, renamedFrom: null };
  }

  const name = folders[0];
  nested.set(blogID, join(container, name));
  return {
    nested: true,
    root: join(container, name),
    name,
    renamedFrom: before && before !== name ? before : null,
  };
};

// Reads every blog's layout, at startup
export const refreshAll = async () => {
  const entries = await fs.readdir(iCloudDriveDirectory, {
    withFileTypes: true,
  });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !BLOG_ID.test(entry.name)) continue;
    try {
      if ((await refresh(entry.name)).nested) count++;
    } catch (error) {
      console.error(
        clfdate(),
        `blogFolder: could not read ${entry.name}:`,
        error.message
      );
    }
  }
  console.log(clfdate(), `blogFolder: ${count} nested blog folder(s)`);
};

// The blog and the path inside its shared folder for a path on disk.
// "" is the folder itself, or anything else inside a nested blog_<id> (the
// marker, the folder under a name it no longer has): the watcher's check of
// the blog folder sorts those out. Null when the path is in no blog folder.
export const locate = (fullPath) => {
  if (!fullPath.startsWith(iCloudDriveDirectory + "/")) return null;
  const relative = fullPath.slice(iCloudDriveDirectory.length + 1);
  const [blogID] = relative.split("/");
  if (!blogID || !blogID.startsWith("blog_")) return null;

  const root = rootOf(blogID);
  if (fullPath === root) return { blogID, path: "" };
  if (fullPath.startsWith(root + "/"))
    return { blogID, path: fullPath.slice(root.length + 1) };
  // inside blog_<id> but outside the folder: only possible when nested
  return { blogID, path: "" };
};

// Makes blog_<id> a nested blog folder holding the folder at `from` (a
// shared folder setup just found, under its owner's name). blog_<id> must
// not exist yet, or be an empty nested one.
export const nest = async (blogID, from) => {
  if (!BLOG_ID.test(blogID)) throw new Error(`Invalid blogID: ${blogID}`);
  const container = containerPath(blogID);
  if (await fs.pathExists(container)) {
    if (!(await fs.pathExists(join(container, MARKER))))
      throw new Error(`${container} exists and is not a nested blog folder`);
    if ((await foldersIn(container)).length)
      throw new Error(`${container} already holds a folder`);
  } else {
    await fs.mkdir(container);
  }
  await fs.writeFile(join(container, MARKER), "");
  const name = from.split("/").pop();
  await fs.rename(from, join(container, name));
  return refresh(blogID);
};

// Removes an empty nested blog_<id> (its folder already left): the marker,
// then the folder, which is Blot's own and holds nothing of the owner's
export const removeContainer = async (blogID) => {
  if (!BLOG_ID.test(blogID)) throw new Error(`Invalid blogID: ${blogID}`);
  const container = containerPath(blogID);
  nested.delete(blogID);
  if (!(await fs.pathExists(join(container, MARKER)))) return false;
  if ((await foldersIn(container)).length)
    throw new Error(`${container} still holds a folder`);
  await fs.remove(join(container, MARKER));
  await fs.rmdir(container);
  return true;
};

// For specs
export const _reset = () => nested.clear();
