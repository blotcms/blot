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

// Nested blogs (their blog_<id> holds the marker), and where each one's
// shared folder is now. Kept apart: a nested blog whose folder has gone
// (left, unshared, deleted) is still nested, and must not fall back to
// blog_<id>, Blot's own folder, for its files.
const nestedBlogs = new Set();
const roots = new Map(); // blogID -> absolute path of the shared folder

// Every path here starts from a blog ID checked against BLOG_ID, so no
// request header can reach outside iCloud Drive or into another folder
export const containerPath = (blogID) => {
  if (typeof blogID !== "string" || !BLOG_ID.test(blogID))
    throw new Error(`Invalid blogID: ${blogID}`);
  return join(iCloudDriveDirectory, blogID);
};

// The shared folder: the folder inside blog_<id> for a nested blog, else
// blog_<id> itself. Throws for a nested blog whose folder is gone, so nothing
// is read from or written to blog_<id> in its place.
export const rootOf = (blogID) => {
  if (!nestedBlogs.has(blogID)) return containerPath(blogID);
  const root = roots.get(blogID);
  if (!root) throw new Error(`The shared folder of ${blogID} is gone`);
  return root;
};

export const isNested = (blogID) => nestedBlogs.has(blogID);

// The owner's name for a nested blog's folder, or null
export const folderNameOf = (blogID) => {
  const root = roots.get(blogID);
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
    nestedBlogs.delete(blogID);
    roots.delete(blogID);
    return { nested: false, root: container, name: null, renamedFrom: null };
  }

  nestedBlogs.add(blogID);

  const folders = await foldersIn(container);
  if (folders.length !== 1) {
    if (folders.length > 1)
      console.error(
        clfdate(),
        `blogFolder: ${blogID} holds ${folders.length} folders: ${folders.join(", ")}`
      );
    roots.delete(blogID);
    return { nested: true, root: null, name: null, renamedFrom: null };
  }

  const name = folders[0];
  roots.set(blogID, join(container, name));
  return {
    nested: true,
    root: join(container, name),
    name,
    renamedFrom: before && before !== name ? before : null,
  };
};

// Reads every blog's layout, at startup. Resolves to the nested blogs'
// { blogID, name }, so their current names can be sent to Blot: a rename
// made while the macserver was stopped is otherwise never reported.
export const refreshAll = async () => {
  const found = [];
  const entries = await fs.readdir(iCloudDriveDirectory, {
    withFileTypes: true,
  });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !BLOG_ID.test(entry.name)) continue;
    try {
      const layout = await refresh(entry.name);
      if (layout.nested) count++;
      if (layout.name) found.push({ blogID: entry.name, name: layout.name });
    } catch (error) {
      console.error(
        clfdate(),
        `blogFolder: could not read ${entry.name}:`,
        error.message
      );
    }
  }
  console.log(clfdate(), `blogFolder: ${count} nested blog folder(s)`);
  return found;
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

  // a nested blog whose folder is gone: all of blog_<id> is "the folder"
  if (nestedBlogs.has(blogID) && !roots.has(blogID))
    return { blogID, path: "" };

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

// Removes an empty nested blog_<id> (its folder already left), which is
// Blot's own and holds nothing of the owner's: Finder's dot-files (a
// .DS_Store from leaveFolder's window), then the marker, then the folder. The
// marker goes last and comes back if the folder can't be removed, so a retry
// still knows the layout.
export const removeContainer = async (blogID) => {
  if (!BLOG_ID.test(blogID)) throw new Error(`Invalid blogID: ${blogID}`);
  const container = containerPath(blogID);
  if (!(await fs.pathExists(join(container, MARKER)))) {
    nestedBlogs.delete(blogID);
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
  nestedBlogs.delete(blogID);
  roots.delete(blogID);
  return true;
};

// For specs
export const _reset = () => {
  nestedBlogs.clear();
  roots.clear();
};
