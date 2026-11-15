const folder = require("storage/folder");

// The folder a template reads when `folder_root` is empty or missing
const DEFAULT_FOLDER_ROOT = "/Posts";

// How many directories one listing returns, and how many entries of the
// directory it reads to find them. A directory holding more than that shows
// its first directories by name; the person can still type the rest.
const MAX_DIRECTORIES = 200;
const MAX_ENTRIES = 5000;

// A path inside the blog's folder with a leading slash and no trailing
// slash ("Posts/" becomes "/Posts"; "/" is the whole folder). Resolves to
// null for anything which isn't a string or which climbs out with "..".
function normalize(value) {
  if (typeof value !== "string") return null;

  // eslint-disable-next-line no-control-regex -- a NUL or other control character can't be part of a folder name
  if (/[\u0000-\u001f]/.test(value)) return null;

  const segments = value
    .normalize("NFC")
    .trim()
    .split(/[\\/]+/)
    .filter((segment) => segment !== "" && segment !== ".");

  if (segments.some((segment) => segment.trim() === "..")) return null;

  return "/" + segments.join("/");
}

// The path of the directory which path names, spelled as it is stored
// (the matcher ignores case, so the editor does too), or null if there is
// no such directory
async function find(blogID, path) {
  if (path === "/") return "/";

  let found;

  try {
    found = await folder.resolveCaseInsensitive(blogID, path);
    if (!(await folder.stat(blogID, found)).isDirectory) return null;
  } catch (err) {
    if (err instanceof folder.NotFoundError) return null;
    throw err;
  }

  return found;
}

// The names of the directories directly inside dir, in name order, without
// reading the whole tree
async function directories(blogID, dir) {
  const names = [];
  let cursor;
  let read = 0;

  do {
    const page = await folder.list(blogID, dir, { cursor });

    for (const entry of page.entries) {
      if (entry.isDirectory && !entry.name.startsWith(".")) {
        names.push(entry.name);
      }
    }

    read += page.entries.length;
    cursor = page.cursor;
  } while (cursor && read < MAX_ENTRIES && names.length < MAX_DIRECTORIES);

  return names.slice(0, MAX_DIRECTORIES);
}

module.exports = {
  DEFAULT_FOLDER_ROOT,
  normalize,
  find,
  directories,
};
