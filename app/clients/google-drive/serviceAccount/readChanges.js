// Reads every change Drive records for a service account with changes.list,
// once a second, and works out which blogs each change belongs to (#2847).
//
// Why poll when changes.watch sends webhooks: in trials on drivetest (20 Nov
// 2026) changes.list listed every change 0.3-1.1s after Google's own change
// time, including renames, moves, trashes and files copied in with an old
// modified time. The webhook usually arrived within 0.5s of that too, but
// often enough it didn't: 7s late on an append (published 12.8s after the
// change instead of about 3s), 5.4s on the last of a burst of edits, 4s on a
// new folder, and once 12.8s. So webhooks alone leave some changes waiting
// 5-13s, and a poll every second bounds that.
//
// The page token is kept in Redis, so the process which takes over the lease
// after a deploy carries on where the last one stopped. init.js runs one
// reader per service account, under a lease, in one process at a time.
//
// Each change is logged with its lag from Google's change time, so the
// webhook's delay can be measured across every customer, and init.js passes
// an onChanges which syncs the blogs it belongs to (syncChanges.js).
const client = require("models/client");
const clfdate = require("helper/clfdate");
const database = require("clients/google-drive/database");
const PREFIX = require("../database/prefix");

const POLL_EVERY_MS = 1000;
// How long the list of a service account's blogs is reused
const BLOGS_TTL_MS = 30 * 1000;
// Pause after Drive rate-limits us, before the next read
const RATE_LIMIT_BACKOFF_MS = 10 * 1000;

const FIELDS =
  "nextPageToken,newStartPageToken,changes(fileId,removed,time,file(name,mimeType,parents,trashed))";

const tokenKey = (serviceAccountId) =>
  `${PREFIX}changes-page-token:${serviceAccountId}`;

const prefix = () => `${clfdate()} Google Drive changes:`;

// Resolves after ms, or as soon as the signal aborts
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

const statusOf = (err) =>
  Number(err?.code || err?.status || err?.response?.status) || null;

// A stored token Drive no longer accepts
const isInvalidToken = (err) =>
  [404, 410].includes(statusOf(err)) ||
  /page ?token/i.test(String(err?.message));

const isRateLimited = (err) => [403, 429].includes(statusOf(err));

// The blogs on a service account which have a folder: [{ blogID, folderId }]
async function blogsOf(serviceAccountId) {
  const blogs = [];
  await database.blog.iterateByServiceAccountId(
    serviceAccountId,
    async (blogID, account) => {
      if (account?.folderId) blogs.push({ blogID, folderId: account.folderId });
    }
  );
  return blogs;
}

// Which blogs each change belongs to. A change belongs to a blog when the
// blog's folder mapping (database/folder.js) holds the file itself (so an
// edit, rename, trash or move out) or one of its parents (so a new file, or
// one moved in). Directories are in the mapping too, the root as "/".
// Resolves to [{ change, blogID, folderId, path, parentPath }], one entry per
// change and blog, and entries with blogID null for changes no blog holds.
async function placeChanges(blogs, changes) {
  const ids = [
    ...new Set(
      changes.flatMap((change) => [
        change.fileId,
        ...(change.file?.parents || []),
      ])
    ),
  ].filter(Boolean);

  const paths = await Promise.all(
    blogs.map(async ({ blogID, folderId }) => {
      const values = ids.length
        ? await client.hmGet(database.folder(folderId, blogID).key, ids)
        : [];
      return new Map(ids.map((id, i) => [id, values[i]]));
    })
  );

  const placed = [];
  for (const change of changes) {
    let found = false;
    blogs.forEach(({ blogID, folderId }, i) => {
      const path = paths[i].get(change.fileId) || null;
      const parent = (change.file?.parents || []).find((id) =>
        paths[i].get(id)
      );
      const parentPath = parent ? paths[i].get(parent) : null;
      if (!path && !parentPath) return;
      found = true;
      placed.push({ change, blogID, folderId, path, parentPath });
    });
    if (!found)
      placed.push({
        change,
        blogID: null,
        folderId: null,
        path: null,
        parentPath: null,
      });
  }
  return placed;
}

const kindOf = (change) =>
  change.removed ? "removed" : change.file?.trashed ? "trashed" : "changed";

function logChanges(serviceAccountId, placed, source = "changes") {
  const now = Date.now();
  for (const { change, blogID, path, parentPath } of placed) {
    const lag = change.time ? now - Date.parse(change.time) : "";
    console.log(
      prefix(),
      `client_id=${serviceAccountId}`,
      `source=${source}`,
      `file=${change.fileId}`,
      `blog=${blogID || "-"}`,
      `kind=${kindOf(change)}`,
      `path=${JSON.stringify(path || "")}`,
      `parent=${JSON.stringify(parentPath || "")}`,
      `name=${JSON.stringify(change.file?.name || "")}`,
      `change_time=${change.time || ""}`,
      `lag_ms=${lag}`
    );
  }
}

async function startToken(drive) {
  const res = await drive.changes.getStartPageToken({
    supportsAllDrives: true,
  });
  return res.data.startPageToken;
}

// Reads changes until the signal aborts. options.onChanges(serviceAccountId,
// placed) is called with each batch (default: log them); the page token moves
// on only once it has resolved, so a batch it fails on is read again.
module.exports = async function readChanges(
  serviceAccountId,
  drive,
  signal = new AbortController().signal,
  { pollMs = POLL_EVERY_MS, onChanges = logChanges } = {}
) {
  if (!serviceAccountId || !drive) {
    throw new Error("Missing required arguments for readChanges");
  }

  let blogs = null;
  let blogsAt = 0;

  while (!signal.aborted) {
    try {
      let token = await client.get(tokenKey(serviceAccountId));
      if (!token) {
        token = await startToken(drive);
        await client.set(tokenKey(serviceAccountId), token);
        console.log(prefix(), `client_id=${serviceAccountId} started reading`);
      }

      const changes = [];
      let pageToken = token;
      let newStartPageToken = null;
      do {
        const res = await drive.changes.list({
          pageToken,
          pageSize: 1000,
          fields: FIELDS,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
        });
        changes.push(...(res.data.changes || []));
        pageToken = res.data.nextPageToken;
        newStartPageToken = res.data.newStartPageToken || newStartPageToken;
      } while (pageToken && !signal.aborted);

      if (changes.length) {
        if (!blogs || Date.now() - blogsAt > BLOGS_TTL_MS) {
          blogs = await blogsOf(serviceAccountId);
          blogsAt = Date.now();
        }
        await onChanges(serviceAccountId, await placeChanges(blogs, changes));
      }

      if (newStartPageToken && newStartPageToken !== token) {
        await client.set(tokenKey(serviceAccountId), newStartPageToken);
      }
    } catch (err) {
      if (isInvalidToken(err)) {
        // Start again from now. Changes in between are left to the webhook,
        // the pollers and the hourly walk, as before this reader existed.
        console.error(
          prefix(),
          `client_id=${serviceAccountId} page token refused, starting again:`,
          err.message
        );
        await client.del(tokenKey(serviceAccountId)).catch(() => {});
      } else {
        console.error(
          prefix(),
          `client_id=${serviceAccountId} read failed:`,
          err.message
        );
        if (isRateLimited(err)) await sleep(RATE_LIMIT_BACKOFF_MS, signal);
      }
    }

    await sleep(pollMs, signal);
  }
};

module.exports.placeChanges = placeChanges;
module.exports.blogsOf = blogsOf;
module.exports.logChanges = logChanges;
module.exports.tokenKey = tokenKey;
