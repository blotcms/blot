// Lists the directories that changed in the last few minutes, again and
// again, every 500ms, and syncs a blog as soon as one of its listings differs
// from the last (#2847).
//
// Why, beside changes.list, the search and the webhook: in trials on
// drivetest (20 Nov 2026) a directory's own listing showed a change 1-2s
// before changes.list did, and walks started by a webhook created new
// folders 0.19s and 1.09s before any other source had them. Listing every
// directory of every blog that often is out of the question, but changes
// cluster: a folder being written to (a drag and drop, a bulk upload, a run
// of edits) gets its next change seconds after its last. So the directories
// any source saw change (database/recent.js) are listed until they have been
// quiet for five minutes, and new folders that appear in them are added.
//
// The first listing of a directory only notes what is there: the source that
// made it recent has already recorded that change. Each later difference
// records the directory as changed with source "recent" (so the live line's
// seen_by= says when this poller saw it first) and runs the blog's sync.
//
// Rate: at most LISTINGS_PER_SECOND files.list calls per service account,
// counting every page of a large directory, for the newest MAX_DIRS
// directories, so a round takes longer than 500ms only when it made more
// than 8 calls. Drive allows far more listings
// per service account than that (a walk lists 16 directories at once).
const clfdate = require("helper/clfdate");
const database = require("../database");
const driveReaddir = require("../sync/util/driveReaddir");

const EVERY_MS = 500;
const LISTINGS_PER_SECOND = 16;
const MAX_DIRS = 16;
const RATE_LIMIT_BACKOFF_MS = 10 * 1000;

const FOLDER = "application/vnd.google-apps.folder";

const prefix = () => `${clfdate()} Google Drive recent:`;

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

const statusOf = (err) =>
  Number(err?.code || err?.status || err?.response?.status) || null;

// What a listing says, to tell when it changes
const fingerprint = (items) =>
  items
    .map((item) =>
      [
        item.id,
        item.name,
        item.mimeType,
        item.modifiedTime,
        item.md5Checksum || "",
        item.size || "",
      ].join("|")
    )
    .sort()
    .join("\n");

// Lists the recent directories until the signal aborts. onChanged(
// serviceAccountId, [{ blogID, dirId, folders }]) is called with each round's
// changed directories, folders being the ids of the folders now in each.
module.exports = async function pollRecentFolders(
  serviceAccountId,
  drive,
  signal = new AbortController().signal,
  {
    onChanged,
    everyMs = EVERY_MS,
    readdir = driveReaddir,
    now = () => Date.now(),
  } = {}
) {
  if (!serviceAccountId || !drive || !onChanged) {
    throw new Error("Missing required arguments for pollRecentFolders");
  }

  // "<blogID> <dirId>" -> the fingerprint of its last listing
  const last = new Map();

  // Counts each files.list call, every page included, for the rate
  let calls = 0;
  // googleapis puts the methods on prototypes, so these inherit them
  const counted = Object.create(drive);
  counted.files = Object.create(drive.files);
  counted.files.list = (...args) => {
    calls += 1;
    return drive.files.list(...args);
  };

  while (!signal.aborted) {
    const startedAt = now();
    let dirs = [];
    let rateLimited = false;
    calls = 0;
    try {
      dirs = await database.recent.list(serviceAccountId, MAX_DIRS, now());
      const listed = new Set(
        dirs.map(({ blogID, dirId }) => blogID + " " + dirId)
      );
      for (const member of last.keys())
        if (!listed.has(member)) last.delete(member);

      const results = await Promise.all(
        dirs.map(async ({ blogID, dirId }) => {
          try {
            return { blogID, dirId, items: await readdir(counted, dirId) };
          } catch (err) {
            if ([403, 429].includes(statusOf(err))) rateLimited = true;
            // A folder gone from Drive is the other sources' to apply
            return null;
          }
        })
      );

      const changed = [];
      for (const result of results) {
        if (!result) continue;
        const { blogID, dirId, items } = result;
        const member = blogID + " " + dirId;
        const print = fingerprint(items);
        const before = last.get(member);
        last.set(member, print);
        if (before === undefined || before === print) continue;
        changed.push({
          blogID,
          dirId,
          folders: items
            .filter((item) => item.mimeType === FOLDER)
            .map((item) => item.id),
        });
      }

      if (changed.length) await onChanged(serviceAccountId, changed);
    } catch (err) {
      console.error(
        prefix(),
        `client_id=${serviceAccountId} poll failed:`,
        err.message
      );
    }

    if (rateLimited) {
      console.error(prefix(), `client_id=${serviceAccountId} rate limited`);
      await sleep(RATE_LIMIT_BACKOFF_MS, signal);
      continue;
    }

    const round = Math.max(
      everyMs,
      Math.ceil((Math.max(calls, dirs.length) / LISTINGS_PER_SECOND) * 1000)
    );
    await sleep(round - (now() - startedAt), signal);
  }
};

module.exports.fingerprint = fingerprint;
