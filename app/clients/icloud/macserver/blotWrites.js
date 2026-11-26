// Changes Blot asked the macserver to make in a blog folder (/upload, /delete,
// /mkdir). The watcher keeps running while the routes make them: stopping it
// dropped every change the customer made meanwhile, and the restarted
// watcher's first scan took those changes to be in sync already.
//
// A watcher event for one of these paths that matches what Blot did is Blot's
// own echo, so it is not sent back. An upload's echo is caught by its
// fingerprint (the route records the written file as pushed, see
// pushedFiles.js); removals and new directories have no fingerprint, so they
// are remembered here for a minute. Anything else at the path, such as the
// customer recreating a file Blot just deleted, still goes through: a removal
// only counts as an echo while the path is still gone.

const TTL_MS = 60_000;

// `${blogID}:${path}` -> { action, at }
const expected = new Map();

// NFC, as pushedFiles.js: an event can spell Blot's own write the other way
const key = (blogID, path) => `${blogID}:${path.normalize("NFC")}`;

const prune = (now) => {
  for (const [k, entry] of expected) {
    if (now - entry.at > TTL_MS) expected.delete(k);
  }
};

// action is "remove" or "mkdir"
const expectBlotChange = (blogID, path, action) => {
  const now = Date.now();
  prune(now);
  expected.set(key(blogID, path), { action, at: now });
};

const matches = (blogID, path, action) => {
  const entry = expected.get(key(blogID, path));
  if (!entry) return false;
  if (Date.now() - entry.at > TTL_MS) {
    expected.delete(key(blogID, path));
    return false;
  }
  return entry.action === action;
};

// A removal is also Blot's when it removed a folder above the path: the
// watcher reports each file inside a deleted folder on its own
const isBlotEcho = (blogID, path, action) => {
  if (matches(blogID, path, action)) return true;
  if (action !== "remove") return false;
  for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) {
    if (matches(blogID, path.slice(0, i), "remove")) return true;
  }
  return false;
};

// A removal that wasn't Blot's, or a file uploaded at the path: whatever Blot
// did there, or under it, is over. A folder recreated there is the
// customer's, and so is a later removal of a file put back there.
const forgetBlotChange = (blogID, path) => {
  const k = key(blogID, path);
  for (const existing of expected.keys()) {
    if (existing === k || existing.startsWith(k + "/"))
      expected.delete(existing);
  }
};

const forgetBlotChanges = (blogID) => {
  const prefix = `${blogID}:`;
  for (const k of expected.keys()) if (k.startsWith(prefix)) expected.delete(k);
};

export {
  expectBlotChange,
  isBlotEcho,
  forgetBlotChange,
  forgetBlotChanges,
  TTL_MS,
};
