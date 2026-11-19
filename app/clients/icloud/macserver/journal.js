// bird's change journal. Every change bird applies to an item in iCloud Drive
// raises that item's item_notifs_rank in its database (client.db) to a new
// global high, and the folder the item is in is raised with it. Reading the
// rows above the last rank seen therefore lists exactly what changed, in
// every shared folder, whether or not FSEvents reported it. Deletions show up
// as a raised folder that has lost a child.
//
// The macserver uses it as a second source of events next to FSEvents, and
// to pick up where it left off after a restart: the last rank is saved, and
// the paths that changed while it was down are pushed on startup.
//
// Like birdState.js this is best effort and read-only: without the database
// nothing here runs and the watcher works from FSEvents and its sweep alone.

import fs from "fs-extra";
import { homedir } from "os";
import { join } from "path";
import clfdate from "./util/clfdate.js";
import { database } from "./birdState.js";

const POLL_MS = 2_000;
const SAVE_EVERY_MS = 10_000;
const MAX_REPLAY = 5_000;
// where the last rank seen is kept; JOURNAL_STATE_FILE moves it, for a
// second copy of the macserver run beside the real one
const STATE_FILE =
  process.env.JOURNAL_STATE_FILE ||
  join(homedir(), "Library/Application Support/blot-macserver/journal.json");

const COLUMNS =
  "zone_rowid z, hex(item_id) id, hex(item_parent_id) pid, item_parent_zone_rowid pz, item_filename name, item_type type, item_state state, item_notifs_rank rank";

const items = new Map(); // "z:id" -> row
const children = new Map(); // "pz:pid" -> Set of "z:id"
const roots = new Map(); // "z:id" -> blogID
const key = (z, id) => `${z}:${id}`;

let statements = null;
let lastRank = 0;
let savedRank = 0;
let lastSave = 0;
let timer = null;
let polling = false;
let pollAgain = false;
let onChange = null;

const index = (row) => {
  const k = key(row.z, row.id);
  const old = items.get(k);
  if (old) children.get(key(old.pz, old.pid))?.delete(k);
  items.set(k, row);
  const parent = key(row.pz, row.pid);
  if (!children.has(parent)) children.set(parent, new Set());
  children.get(parent).add(k);
  if (row.name && row.name.startsWith("blog_") && row.pz !== row.z) {
    roots.set(k, row.name);
  }
};

const unindex = (k) => {
  const row = items.get(k);
  if (!row) return;
  children.get(key(row.pz, row.pid))?.delete(k);
  items.delete(k);
};

// blogID and path in the blog folder for an indexed row, or null when it is
// outside every blog folder (or is a blog folder itself)
const locate = (row) => {
  const names = [];
  for (let depth = 0, at = row; at && depth < 200; depth++) {
    const k = key(at.z, at.id);
    if (roots.has(k)) {
      return names.length
        ? { blogID: roots.get(k), path: names.reverse().join("/") }
        : null;
    }
    names.push(at.name);
    at = items.get(key(at.pz, at.pid));
  }
  return null;
};

const readState = async () => {
  try {
    return (await fs.readJson(STATE_FILE)).rank || 0;
  } catch {
    return 0;
  }
};

const saveState = async (force = false) => {
  if (lastRank === savedRank) return;
  if (!force && Date.now() - lastSave < SAVE_EVERY_MS) return;
  lastSave = Date.now();
  try {
    await fs.outputJson(STATE_FILE, { rank: lastRank, at: new Date() });
    savedRank = lastRank;
  } catch (error) {
    console.warn(clfdate(), "journal: could not save its position:", error);
  }
};

// Applies rows read above lastRank, calling report(blogID, path) for every
// path they touch, including children a raised folder no longer has
const apply = (rows, report) => {
  for (const row of rows) {
    lastRank = Math.max(lastRank, row.rank);
    const before = items.get(key(row.z, row.id));
    const beforeAt = before && locate(before);
    index(row);

    const at = locate(row);
    if (at) report(at.blogID, at.path);

    // moved or renamed: the old path is gone too
    if (beforeAt && (!at || beforeAt.path !== at.path)) {
      report(beforeAt.blogID, beforeAt.path);
    }

    // a folder (or a blog folder) was raised: compare its children
    if (row.type === 0 || row.type === 9 || roots.has(key(row.z, row.id))) {
      const parent = key(row.z, row.id);
      const now = new Set();
      for (const child of statements.children.all(row.z, row.id)) {
        const k = key(child.z, child.id);
        now.add(k);
        if (!items.has(k)) {
          index(child);
          const childAt = locate(child);
          if (childAt) report(childAt.blogID, childAt.path);
        }
      }
      for (const k of [...(children.get(parent) || [])]) {
        if (now.has(k)) continue;
        const gone = items.get(k);
        const goneAt = gone && locate(gone);
        unindex(k);
        if (goneAt) report(goneAt.blogID, goneAt.path);
      }
    }
  }
};

const poll = async () => {
  if (!statements || !onChange) return;
  if (polling) {
    pollAgain = true;
    return;
  }
  polling = true;

  try {
    do {
      pollAgain = false;
      const rows = statements.since.all(lastRank);
      if (!rows.length) break;
      const touched = new Map();
      apply(rows, (blogID, path) =>
        touched.set(`${blogID}/${path}`, { blogID, path })
      );
      for (const { blogID, path } of touched.values()) onChange(blogID, path);
    } while (pollAgain);
    await saveState();
  } catch (error) {
    console.error(clfdate(), "journal: poll failed:", error.message);
  } finally {
    polling = false;
  }
};

// Loads bird's items and works out what changed since the saved position.
// Resolves to the { blogID, path, isFile } entries to push after the blogs
// are watched
// (empty the first time, when there is no saved position), or null when the
// database can't be read.
const openJournal = async () => {
  const db = await database();
  if (!db) return null;

  try {
    statements = {
      all: db.prepare(`select ${COLUMNS} from client_items`),
      since: db.prepare(
        `select ${COLUMNS} from client_items where item_notifs_rank > ? order by item_notifs_rank limit 5000`
      ),
      children: db.prepare(
        `select ${COLUMNS} from client_items where item_parent_zone_rowid = ? and item_parent_id = unhex(?)`
      ),
      max: db.prepare("select max(item_notifs_rank) m from client_items"),
    };

    const started = Date.now();
    for (const row of statements.all.all()) index(row);
    const max = statements.max.get().m || 0;
    const saved = await readState();

    const replay = [];
    if (saved && saved < max) {
      for (const row of items.values()) {
        if (row.rank <= saved) continue;
        const at = locate(row);
        if (at) replay.push({ ...at, isFile: row.type === 1 });
      }
    }

    lastRank = max;
    console.log(
      clfdate(),
      `journal: ${items.size} items in ${roots.size} blog folders loaded in ${Date.now() - started}ms; ${replay.length} changed since the last run${saved ? "" : " (first run)"}`
    );

    if (replay.length > MAX_REPLAY) {
      console.warn(
        clfdate(),
        `journal: ${replay.length} paths changed while stopped, pushing the first ${MAX_REPLAY}; the sweep and validation cover the rest`
      );
      replay.length = MAX_REPLAY;
    }

    await saveState(true);
    return replay;
  } catch (error) {
    console.error(clfdate(), "journal: could not start:", error.message);
    statements = null;
    return null;
  }
};

// Starts polling; handler(blogID, path) is called for each changed path
const startJournal = (handler) => {
  if (!statements || timer) return;
  onChange = handler;
  timer = setInterval(poll, POLL_MS);
  timer.unref?.();
};

// Polls now instead of at the next tick (brctl monitor saw something)
const pollJournalSoon = () => {
  poll().catch(() => {});
};

const journalRunning = () => Boolean(timer);

export { openJournal, startJournal, pollJournalSoon, journalRunning };
