// A read-only view of what bird (the iCloud Drive daemon) knows about a file,
// from its own database. bird learns about a change in a shared folder before
// FileProvider updates the file on disk: an edit to a file that is already
// downloaded can take tens of seconds to reach the disk, and a new file's
// record can exist, empty, before its data has been uploaded. Comparing the
// disk with bird's version tells us whether the disk is still behind.
//
// The database is Apple's and undocumented, so everything here is best
// effort: if node:sqlite, the file or the columns we read are missing, every
// lookup returns null and callers carry on as if there were no database.
// It is opened read-only and never written.

import { homedir } from "os";
import { join } from "path";
import clfdate from "./util/clfdate.js";

const DB_PATH = join(
  homedir(),
  "Library/Application Support/CloudDocs/session/db/client.db"
);

let db = null;
let statements = null;
let unavailable = false;
const roots = new Map(); // blogID -> { z, id }

const open = async () => {
  if (statements) return statements;
  if (unavailable) return null;

  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(DB_PATH, { readOnly: true });
    statements = {
      // blog_<id> is a plain folder in the account's zone (blogFolder.js),
      // and the shared folder is the root of its own zone inside it
      container: db.prepare(
        "select zone_rowid z, item_id id from client_items where item_filename = ? and item_parent_zone_rowid = zone_rowid"
      ),
      nestedRoot: db.prepare(
        "select zone_rowid z, item_id id from client_items where item_parent_zone_rowid = ? and item_parent_id = ? and zone_rowid != item_parent_zone_rowid and item_type in (0, 9)"
      ),
      child: db.prepare(
        "select zone_rowid z, item_id id, item_type type, item_state state, item_localsyncupstate up, item_local_diffs diffs, version_size size, version_mtime mtime, hex(version_content_signature) sig from client_items where item_parent_zone_rowid = ? and item_parent_id = ? and item_filename = ?"
      ),
    };
    console.log(clfdate(), "birdState: reading bird's database");
    return statements;
  } catch (error) {
    unavailable = true;
    console.warn(
      clfdate(),
      "birdState: bird's database is unavailable, carrying on without it:",
      error.message
    );
    return null;
  }
};

// bird may replace its database; drop the connection so the next lookup
// opens it again
const reset = (error) => {
  console.warn(
    clfdate(),
    "birdState: lookup failed, reopening:",
    error.message
  );
  try {
    db?.close();
  } catch {
    // already closed
  }
  db = null;
  statements = null;
  roots.clear();
};

// A blog's folder changed (nested by setup, or left): look its root up again
const forgetRoot = (blogID) => roots.delete(blogID);

const lookup = (s, blogID, pathInBlogDirectory) => {
  let node = roots.get(blogID);
  if (!node) {
    const container = s.container.get(blogID);
    const shared = container && s.nestedRoot.all(container.z, container.id);
    // exactly one shared folder inside, as blogFolder.js expects
    if (!shared || shared.length !== 1) return null;
    node = shared[0];
    roots.set(blogID, node);
  }

  const names = pathInBlogDirectory.split("/").filter(Boolean);
  let row = null;
  for (const name of names) {
    row =
      s.child.get(node.z, node.id, name) ||
      s.child.get(node.z, node.id, name.normalize("NFC")) ||
      s.child.get(node.z, node.id, name.normalize("NFD"));
    if (!row) return null;
    node = row;
  }
  return row;
};

// Resolves to { size, mtime (whole seconds), sig } for a file bird knows,
// or null when it doesn't know it or the database can't be read
const fileVersion = async (blogID, pathInBlogDirectory) => {
  const s = await open();
  if (!s) return null;

  try {
    const row = lookup(s, blogID, pathInBlogDirectory);
    if (!row || row.type !== 1) return null;
    return { size: row.size, mtime: row.mtime, sig: row.sig };
  } catch (error) {
    reset(error);
    return null;
  }
};

// True when bird has a file or folder at the path. False when it has none or
// the database can't be read, so callers fall back to what the disk says.
const itemAt = async (blogID, pathInBlogDirectory) => {
  const s = await open();
  if (!s) return false;

  try {
    const row = lookup(s, blogID, pathInBlogDirectory);
    return Boolean(row && row.state === 0);
  } catch (error) {
    reset(error);
    return false;
  }
};

// Whether bird has finished uploading the file at the path, in the given
// size: true or false, or null when it doesn't know the file or the database
// can't be read. An item with nothing left to send has a sync-up state and
// local diffs of 0; a file still uploading, or edited since, has neither.
const syncedUp = async (blogID, pathInBlogDirectory, size) => {
  const s = await open();
  if (!s) return null;

  try {
    const row = lookup(s, blogID, pathInBlogDirectory);
    if (!row || row.type !== 1 || row.state !== 0) return null;
    return row.up === 0 && row.diffs === 0 && row.size === size;
  } catch (error) {
    reset(error);
    return null;
  }
};

// The open database, for journal.js, or null
const database = async () => ((await open()) ? db : null);

// True when the file on disk (an fs.Stats) is the version bird has
const diskMatches = (version, stat) =>
  stat.size === version.size &&
  Math.floor(stat.mtimeMs / 1000) === version.mtime;

export { fileVersion, diskMatches, itemAt, syncedUp, database, forgetRoot };
