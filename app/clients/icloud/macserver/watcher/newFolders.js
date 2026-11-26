// Folders the macserver has just seen appear in a blog, so the files that
// arrive with one are pushed as such (the fromDirectoryWalk header). A folder
// moved or copied in brings files whose mtimes are as old as their last edit
// elsewhere, and Blot's delay alert measures from the mtime
// (app/clients/icloud/util/liveLag.js). Their per-file watcher events can
// beat the walk of the new folder (watcher/index.js), so the walk's own flag
// isn't enough.
//
// A file saved into a folder made in the last minute loses its lag sample
// too, which only weakens the alert a little.

const WINDOW_MS = 60 * 1000;
const MAX_ENTRIES = 10000;

// `${blogID}:${path}` -> when the folder appeared, oldest first
const appeared = new Map();

const normalise = (path) => path.replace(/^\/+|\/+$/g, "");

const key = (blogID, path) => `${blogID}:${normalise(path)}`;

const markFolderAppeared = (blogID, path, now = Date.now()) => {
  const k = key(blogID, path);
  appeared.delete(k);
  appeared.set(k, now);

  // drop what has aged out, and the oldest past the cap
  for (const [existing, at] of appeared) {
    if (now - at <= WINDOW_MS && appeared.size <= MAX_ENTRIES) break;
    appeared.delete(existing);
  }
};

// Whether the file is inside a folder (at any depth) that appeared in the
// last WINDOW_MS
const arrivedWithFolder = (blogID, path, now = Date.now()) => {
  const parts = normalise(path).split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const at = appeared.get(key(blogID, parts.slice(0, i).join("/")));
    if (at !== undefined && now - at <= WINDOW_MS) return true;
  }
  return false;
};

export { markFolderAppeared, arrivedWithFolder, WINDOW_MS };
