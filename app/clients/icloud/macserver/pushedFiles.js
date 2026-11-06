// The size and mtime of each file as it was when last pushed to Blot, so a
// watcher event for a file that hasn't changed since can be dropped without
// downloading it. iCloud evicts and re-materialises files without touching
// their size or mtime (only ctime), and fs.watch reports each flip as a
// change: without this, every eviction pass re-downloads and re-uploads
// thousands of unchanged files, and each download that times out asks Blot
// for a full resync.
//
// Kept in memory only, so the first event for each file after a restart is
// pushed as before. Past MAX_ENTRIES_PER_BLOG a blog's oldest entries are
// dropped, which only means those files are pushed again on their next event.

const MAX_ENTRIES_PER_BLOG = 100000;

// blogID -> Map(path -> fingerprint)
const blogs = new Map();

const fingerprint = (stat) => `${stat.size}:${stat.mtimeMs}`;

const isUnchanged = (blogID, path, stat) =>
  blogs.get(blogID)?.get(path) === fingerprint(stat);

// Directories Blot already has are recorded too, so a walk of an existing
// folder doesn't ask Blot to create every subfolder again. No file's
// fingerprint can equal this marker.
const DIRECTORY = "directory";

const isKnownDirectory = (blogID, path) =>
  blogs.get(blogID)?.get(path) === DIRECTORY;

const record = (blogID, path, value) => {
  if (!blogs.has(blogID)) blogs.set(blogID, new Map());
  const pushed = blogs.get(blogID);

  // re-inserting moves the entry to the end, so the oldest are dropped first
  pushed.delete(path);
  pushed.set(path, value);

  if (pushed.size > MAX_ENTRIES_PER_BLOG) {
    pushed.delete(pushed.keys().next().value);
  }
};

const recordPushed = (blogID, path, stat) => record(blogID, path, fingerprint(stat));

const recordDirectory = (blogID, path) => record(blogID, path, DIRECTORY);

// Forgets the path and, if it was a directory, everything under it: a folder
// moved out of the blog and back keeps its files' mtimes, and must be pushed.
const forgetPath = (blogID, path) => {
  const pushed = blogs.get(blogID);
  if (!pushed) return;

  pushed.delete(path);

  const prefix = path + "/";
  for (const existing of pushed.keys()) {
    if (existing.startsWith(prefix)) pushed.delete(existing);
  }
};

const forgetBlog = (blogID) => {
  blogs.delete(blogID);
};

// True, once, for a blog with no record yet: the first time it is watched in
// this process (or after forgetBlog). Only that first initial scan may record
// files as pushed. The routes that write to the folder restart the watcher,
// and a later scan would record an edit whose upload is still queued.
const startTracking = (blogID) => {
  if (blogs.has(blogID)) return false;
  blogs.set(blogID, new Map());
  return true;
};

export {
  isUnchanged,
  recordPushed,
  isKnownDirectory,
  recordDirectory,
  forgetPath,
  forgetBlog,
  startTracking,
  MAX_ENTRIES_PER_BLOG,
};
