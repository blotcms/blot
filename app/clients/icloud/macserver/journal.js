// bird's change journal. Every change bird applies to an item in iCloud Drive
// raises that item's item_notifs_rank in its database (client.db) to a new
// global high, and the folder the item is in is raised with it. Reading the
// rows above the last rank seen therefore lists exactly what changed, in
// every shared folder, whether or not FSEvents reported it. Deletions show up
// as a raised folder that has lost a child.
//
// The macserver uses it as a second source of events next to FSEvents, and
// to pick up where it left off after a restart: the last rank is saved, and
// the paths that changed while it was down are pushed on startup. The rank
// saved is only ever one whose pushes have all finished: the pushes are
// queued in memory, so saving a rank as soon as it was read lost every push
// still queued when the macserver stopped, until Blot's hourly validation
// (for a quiet blog, up to a day).
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
// A batch of pushes still running after this long no longer holds the saved
// position back: a push that never settles would otherwise stop it moving
// for good, and every restart would replay everything since
const STUCK_BATCH_MS = 30 * 60 * 1000;
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
let replayBatch = null;
let lastRank = 0;
let savedRank = 0;
// The rank up to which every push has finished, and the batches of pushes
// still running, oldest first: { upTo, done, since }. With none running, every rank
// read so far (lastRank) is settled.
let settledRank = 0;
const outstanding = [];
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
  // blog_<id> is a plain folder in the account's zone (blogFolder.js), and
  // the blog's root is the shared folder inside it, the root of its own
  // zone, under the owner's name. Either can be indexed first.
  if (row.pz !== row.z) {
    const parent = items.get(key(row.pz, row.pid));
    if (isContainer(parent)) roots.set(k, parent.name);
  }
  if (isContainer(row)) {
    for (const childKey of children.get(k) || []) {
      const child = items.get(childKey);
      if (child && child.pz !== child.z) roots.set(childKey, row.name);
    }
  }
};

const isContainer = (row) =>
  Boolean(row && row.name && row.name.startsWith("blog_") && row.pz === row.z);

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

const settled = (now = Date.now()) => {
  while (outstanding.length) {
    const batch = outstanding[0];
    if (!batch.done && now - batch.since < STUCK_BATCH_MS) break;
    if (!batch.done) {
      console.warn(
        clfdate(),
        `journal: pushes up to rank ${batch.upTo} still running after ${STUCK_BATCH_MS / 60000} minutes, saving past them`
      );
    }
    settledRank = outstanding.shift().upTo;
  }
  return outstanding.length ? settledRank : lastRank;
};

// Counts the rows up to rank upTo as handled once every push they started
// has finished, failed ones included (a failure is not a restart losing it)
const track = (
  upTo,
  pushes,
  batch = { upTo, done: false, since: Date.now() }
) => {
  if (!outstanding.includes(batch)) outstanding.push(batch);
  Promise.allSettled(pushes).then(() => {
    batch.done = true;
    return saveState();
  });
  return batch;
};

const saveState = async (force = false) => {
  const rank = settled();
  if (rank === savedRank) return;
  if (!force && Date.now() - lastSave < SAVE_EVERY_MS) return;
  lastSave = Date.now();
  try {
    await fs.outputJson(STATE_FILE, { rank, at: new Date() });
    savedRank = rank;
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

// Prepared on the shared connection (birdState.js), which birdState closes
// and reopens when a lookup fails: the journal then prepares them again
const prepare = (db) => ({
  all: db.prepare(`select ${COLUMNS} from client_items`),
  since: db.prepare(
    `select ${COLUMNS} from client_items where item_notifs_rank > ? order by item_notifs_rank limit 5000`
  ),
  children: db.prepare(
    `select ${COLUMNS} from client_items where item_parent_zone_rowid = ? and item_parent_id = unhex(?)`
  ),
  max: db.prepare("select max(item_notifs_rank) m from client_items"),
});

const reconnect = async () => {
  const db = await database();
  if (!db) return false;
  statements = prepare(db);
  console.log(clfdate(), "journal: reconnected to bird's database");
  return true;
};

let broken = false;
let lastPollAt = 0; // when a poll last read bird's database without failing

const poll = async () => {
  if (!onChange) return;
  if (broken) {
    try {
      if (!(await reconnect())) return;
      broken = false;
    } catch (error) {
      return;
    }
  }
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
      const pushes = [];
      for (const { blogID, path } of touched.values()) {
        pushes.push(Promise.resolve().then(() => onChange(blogID, path)));
      }
      track(lastRank, pushes);
    } while (pollAgain);
    lastPollAt = Date.now();
    await saveState();
  } catch (error) {
    // most likely the connection was closed under us; prepare again next poll
    console.error(clfdate(), "journal: poll failed:", error.message);
    broken = true;
  } finally {
    polling = false;
  }
};

// Loads bird's items and works out what changed since the saved position.
// Resolves to the { blogID, path, isFile } entries to push after the blogs
// are watched
// (empty the first time, when there is no saved position), or null when the
// database can't be read. The position stays where it was until the pushes
// are passed to trackReplay and have all finished.
const openJournal = async () => {
  const db = await database();
  if (!db) return null;

  try {
    statements = prepare(db);

    const started = Date.now();
    for (const row of statements.all.all()) index(row);
    const max = statements.max.get().m || 0;
    const saved = await readState();
    savedRank = saved;

    const replay = [];
    if (saved && saved < max) {
      for (const row of items.values()) {
        if (row.rank <= saved) continue;
        const at = locate(row);
        if (at) replay.push({ ...at, isFile: row.type === 1 });
      }
    }

    lastRank = max;
    settledRank = saved || max;
    if (replay.length)
      outstanding.push(
        (replayBatch = { upTo: max, done: false, since: Date.now() })
      );
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

// Takes the promises of the pushes openJournal's replay started
const trackReplay = (pushes) => {
  if (!replayBatch) return;
  track(replayBatch.upTo, pushes, replayBatch);
  replayBatch = null;
};

// Starts polling; handler(blogID, path) is called for each changed path, and
// returns a promise that settles once the path has been pushed
const startJournal = (handler) => {
  if (!statements || timer) return;
  onChange = handler;
  // the age of the last poll counts from here until one succeeds, so a
  // journal that fails from the start is reported stale too
  lastPollAt = Date.now();
  timer = setInterval(poll, POLL_MS);
  timer.unref?.();
};

const journalRunning = () => Boolean(timer);

// For /stats: whether the journal is following bird, how long since a poll
// last read its database, and how many changes bird has made since the
// position the journal has reached (0 when it is keeping up)
const journalStatus = (now = Date.now()) => {
  const status = {
    running: journalRunning(),
    pollAgeMs: lastPollAt ? now - lastPollAt : null,
    behind: null,
  };
  if (!status.running || broken || !statements) return status;
  try {
    const { m } = statements.max.get();
    status.behind = Math.max(0, (m || 0) - lastRank);
  } catch {
    // reported as unknown; the next poll reconnects
  }
  return status;
};

export {
  openJournal,
  trackReplay,
  startJournal,
  journalRunning,
  journalStatus,
};
