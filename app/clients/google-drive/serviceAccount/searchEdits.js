// Searches every second for files the service account can see that were
// modified in the last few minutes (files.list, modifiedTime >, newest first),
// and hands the ones it hasn't seen in that state to onChanges (#2847).
//
// Why, beside changes.list: in trials on drivetest (20 Nov 2026) this search
// listed an edit to an existing file 0.3-1.7s before changes.list did (0.6-1.5s
// after Drive's modifiedTime). It is only an extra, faster signal for edits:
// it was 8-38s late for new files and folders, and it never listed a file
// copied in with an old modified time (Drive for desktop keeps the local
// file's), so changes.list stays the source that sees everything.
//
// The first search only notes what is there; later ones pass on what's new.
const clfdate = require("helper/clfdate");
const { placeChanges, blogsOf } = require("./readChanges");
const rateLimit = require("./rateLimit");

const POLL_EVERY_MS = 1000;
// How far back each search looks. Longer than Drive for desktop takes to
// upload an edit (6-8s), since modifiedTime is the local file's.
const WINDOW_MS = 5 * 60 * 1000;
const BLOGS_TTL_MS = 30 * 1000;

const FIELDS =
  "files(id,name,mimeType,parents,trashed,modifiedTime,md5Checksum,size)";

const prefix = () => `${clfdate()} Google Drive search:`;

const sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

// What a file looks like, to tell a new edit from one already passed on
const stateOf = (file) =>
  [file.modifiedTime, file.md5Checksum || "", file.name, file.trashed].join(
    "|"
  );

module.exports = async function searchEdits(
  serviceAccountId,
  drive,
  signal = new AbortController().signal,
  {
    pollMs = POLL_EVERY_MS,
    onChanges,
    now = () => Date.now(),
    backoff = rateLimit.backoff(),
  } = {}
) {
  if (!serviceAccountId || !drive || !onChanges) {
    throw new Error("Missing required arguments for searchEdits");
  }

  // id -> { state, modifiedAt }
  const seen = new Map();
  let primed = false;
  let blogs = null;
  let blogsAt = 0;

  while (!signal.aborted) {
    try {
      const since = new Date(now() - WINDOW_MS).toISOString();
      const res = await drive.files.list({
        q: `modifiedTime > '${since}'`,
        orderBy: "modifiedTime desc",
        pageSize: 100,
        fields: FIELDS,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });

      const fresh = [];
      for (const file of res.data.files || []) {
        const state = stateOf(file);
        if (seen.get(file.id)?.state === state) continue;
        seen.set(file.id, { state, modifiedAt: Date.parse(file.modifiedTime) });
        fresh.push(file);
      }

      // Forget files that have left the window
      const cutoff = now() - WINDOW_MS;
      for (const [id, { modifiedAt }] of seen) {
        if (!(modifiedAt > cutoff)) seen.delete(id);
      }

      if (primed && fresh.length) {
        if (!blogs || now() - blogsAt > BLOGS_TTL_MS) {
          blogs = await blogsOf(serviceAccountId);
          blogsAt = now();
        }
        const changes = fresh.map((file) => ({
          fileId: file.id,
          time: file.modifiedTime,
          file,
        }));
        // Files no blog holds (another app's, say) are dropped here
        const placed = (await placeChanges(blogs, changes)).filter(
          (entry) => entry.blogID
        );
        if (placed.length) await onChanges(serviceAccountId, placed, "search");
      }
      primed = true;
      backoff.reset();
    } catch (err) {
      if (rateLimit.isRateLimited(err)) {
        const wait = backoff.next();
        console.error(
          prefix(),
          `client_id=${serviceAccountId} rate limited`,
          `reason=${rateLimit.reasonOf(err)}`,
          `refusals=${backoff.refusals}`,
          `waiting=${wait}ms`
        );
        await sleep(wait, signal);
      } else {
        console.error(
          prefix(),
          `client_id=${serviceAccountId} search failed:`,
          err.message
        );
      }
    }

    await sleep(pollMs, signal);
  }
};
