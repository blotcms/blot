// Where each blog's shared folder is in iCloud Drive:
//
//   <iCloud Drive>/blog_<id>/<name>
//
// blog_<id> is a plain folder of Blot's own, holding a marker and the shared
// folder under the owner's name. iCloud passes the owner's renames on to a
// participant's copy only while that copy keeps the owner's name: renaming it
// to blog_<id> would cut it off for good. Nested, the folder keeps its name
// and follows the owner's renames, and blog_<id> still keeps blogs with the
// same folder name apart ("Blog", "Blog 2"). See #2874.
//
// Everything that turns a blog and a path into a file on disk goes through
// rootOf(), which is synchronous (it reads a cache) so the many callers that
// build paths stay as they are. refresh() re-reads one blog's folder from
// disk: at startup, after setup nests a folder, and when the watcher sees
// something change inside blog_<id> but outside the folder (a rename).

import fs from "fs-extra";
import { join } from "path";
import { iCloudDriveDirectory } from "./config.js";
import clfdate from "./util/clfdate.js";

// Written into blog_<id> when a folder is nested there. It tells Blot's own
// blog_<id> from anything else: a blog_<id> without it is no blog folder.
export const MARKER = ".blot-nested";

const BLOG_ID = /^blog_[a-zA-Z0-9]+$/;

// Where each blog's shared folder is now. A blog with no entry (its folder
// left, unshared or deleted, or its blog_<id> unmarked) has no shared folder,
// and nothing is read from or written to blog_<id> in its place.
const roots = new Map(); // blogID -> absolute path of the shared folder

// Every path here starts from a blog ID checked against BLOG_ID, so no
// request header can reach outside iCloud Drive or into another folder
export const containerPath = (blogID) => {
  if (typeof blogID !== "string" || !BLOG_ID.test(blogID))
    throw new Error(`Invalid blogID: ${blogID}`);
  return join(iCloudDriveDirectory, blogID);
};

// The shared folder inside blog_<id>. Throws for a blog without one.
export const rootOf = (blogID) => {
  const root = roots.get(blogID);
  if (!root) throw new Error(`The shared folder of ${blogID} is gone`);
  return root;
};

// The blogs whose shared folder is known
export const blogIDs = () => [...roots.keys()];

// The owner's name for a blog's folder, or null
export const folderNameOf = (blogID) => {
  const root = roots.get(blogID);
  return root ? root.slice(containerPath(blogID).length + 1) : null;
};

// The folders in a blog's blog_<id>, the marker left out
const foldersIn = async (container) =>
  (await fs.readdir(container, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);

// Reads one blog's folder from disk. Resolves to { root, name, renamedFrom }:
// renamedFrom is the folder's previous name when it changed since the last
// read. A blog_<id> without the marker, or holding no folder (the share was
// left or deleted) or more than one (not something Blot makes), keeps no
// root: rootOf() then throws, rather than point at a folder that may be the
// wrong one.
export const refresh = async (blogID) => {
  if (!BLOG_ID.test(blogID)) throw new Error(`Invalid blogID: ${blogID}`);
  const container = containerPath(blogID);
  const before = folderNameOf(blogID);
  const none = { root: null, name: null, renamedFrom: null };

  if (!(await fs.pathExists(join(container, MARKER)))) {
    if (await fs.pathExists(container))
      console.error(clfdate(), `blogFolder: ${blogID} has no ${MARKER}`);
    roots.delete(blogID);
    return none;
  }

  const folders = await foldersIn(container);
  if (folders.length !== 1) {
    if (folders.length > 1)
      console.error(
        clfdate(),
        `blogFolder: ${blogID} holds ${folders.length} folders: ${folders.join(", ")}`
      );
    roots.delete(blogID);
    return none;
  }

  const name = folders[0];
  roots.set(blogID, join(container, name));
  return {
    root: join(container, name),
    name,
    renamedFrom: before && before !== name ? before : null,
  };
};

// Reads every blog's folder, at startup. Resolves to each blog's
// { blogID, name }, so their current names can be sent to Blot: a rename
// made while the macserver was stopped is otherwise never reported.
export const refreshAll = async () => {
  const found = [];
  const entries = await fs.readdir(iCloudDriveDirectory, {
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || !BLOG_ID.test(entry.name)) continue;
    try {
      const { name } = await refresh(entry.name);
      if (name) found.push({ blogID: entry.name, name });
    } catch (error) {
      console.error(
        clfdate(),
        `blogFolder: could not read ${entry.name}:`,
        error.message
      );
    }
  }
  console.log(clfdate(), `blogFolder: ${found.length} blog folder(s)`);
  return found;
};

// The blog and the path inside its shared folder for a path on disk.
// "" is the folder itself, or anything else inside blog_<id> (the marker,
// the folder under a name it no longer has, all of a blog_<id> whose folder
// is gone): the watcher's check of the blog folder sorts those out. Null when
// the path is in no blog folder.
export const locate = (fullPath) => {
  if (!fullPath.startsWith(iCloudDriveDirectory + "/")) return null;
  const relative = fullPath.slice(iCloudDriveDirectory.length + 1);
  const [blogID] = relative.split("/");
  if (!blogID || !blogID.startsWith("blog_")) return null;

  const root = roots.get(blogID);
  if (root && fullPath.startsWith(root + "/"))
    return { blogID, path: fullPath.slice(root.length + 1) };
  return { blogID, path: "" };
};

// Makes blog_<id> a blog folder holding the folder at `from` (a
// shared folder setup just found, under its owner's name). blog_<id> must
// not exist yet, or be an empty one with the marker.
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

// Removes an empty blog_<id> (its folder already left), which is
// Blot's own and holds nothing of the owner's: Finder's dot-files (a
// .DS_Store from leaveFolder's window), then the marker, then the folder. The
// marker goes last and comes back if the folder can't be removed, so a retry
// still knows the folder is Blot's.
export const removeContainer = async (blogID) => {
  if (!BLOG_ID.test(blogID)) throw new Error(`Invalid blogID: ${blogID}`);
  const container = containerPath(blogID);
  if (!(await fs.pathExists(join(container, MARKER)))) {
    roots.delete(blogID);
    return false;
  }

  const entries = await fs.readdir(container, { withFileTypes: true });
  const other = entries.filter(
    (entry) =>
      entry.name !== MARKER && !(entry.isFile() && entry.name.startsWith("."))
  );
  if (other.length)
    throw new Error(
      `${container} still holds ${other.map((entry) => entry.name).join(", ")}`
    );

  for (const entry of entries)
    if (entry.name !== MARKER) await fs.remove(join(container, entry.name));
  await fs.remove(join(container, MARKER));
  try {
    await fs.rmdir(container);
  } catch (error) {
    await fs.writeFile(join(container, MARKER), "");
    throw error;
  }
  roots.delete(blogID);
  return true;
};

// For specs
export const _reset = () => {
  roots.clear();
};
