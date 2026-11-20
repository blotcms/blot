import fs from "fs-extra";
import { join } from "path";
import { iCloudDriveDirectory } from "../config.js";
import { refresh, removeContainer, rootOf } from "../blogFolder.js";
import sharePermission from "../util/sharePermission.js";
import { setupBlog, shareInfo } from "./setup.js";
import leaveFolder from "../util/leaveFolder.js";
import finderLimiter from "../util/finderLimiter.js";
import { watch, unwatch } from "../watcher/index.js";
import requestResync from "../httpClient/resync.js";
import status from "../httpClient/status.js";
import clfdate from "../util/clfdate.js";
import * as brctl from "../brctl/index.js";

// Moves one blog from the old layout (blog_<id> is the shared folder, renamed
// by setup) to the nested one (blogFolder.js, #2874), so its folder follows
// the owner's renames. A renamed share never follows them again, so this
// leaves the share and opens its link again: it comes back under the owner's
// current name, and setup nests it.
//
// Run by scripts/icloud/migrate-nested.js, one blog at a time. It answers
// once done, with { folderName } or an error.
//
// Leaving is the one step that can't be taken back, so it happens only when
// the share is still Blot's to rejoin: shared with Blot, Blot may make
// changes, and the same share (by its collaboration ID) must come back.
// Unlike a setup, nothing is copied into the folder afterwards: Blot is asked
// for a resync from iCloud instead, so the owner's latest files win.
// Waits before each rejoin attempt, after leaving: about four minutes in all
const REJOIN_DELAYS_MS = [15_000, 15_000, 30_000, 60_000, 120_000];
const RETRYABLE = ["INVALID_LINK", "TIMEOUT"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How long to wait, after the rejoin, for iCloud to list the folder's files
// again. Until it has, a walk of the folder would remove from the site every
// file not listed yet
const SETTLE_TIMEOUT_MS = 30 * 60_000;
const SETTLE_POLL_MS = 5_000;
// The owner may remove a few files meanwhile, which never come back: once no
// more have appeared for this long, that many missing is accepted, and the
// resync removes them from the site
const SETTLE_STABLE_MS = 60_000;

// Every file and folder in a blog folder, as paths inside it. Dot-names are
// left out: Finder's .DS_Store comes and goes
const listPaths = async (root) => {
  const paths = [];
  const walk = async (dir, prefix) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      paths.push(path);
      if (entry.isDirectory()) await walk(join(dir, entry.name), path);
    }
  };
  await walk(root, "");
  return paths;
};

// Directories a poll asks iCloud to list, at most: see waitForFiles
const MATERIALISE_PER_POLL = 50;

// Resolves to the folder's name (the owner may rename it meanwhile) once the
// rejoined folder lists every path it held before the leave, or all but a
// few (about 1%) and nothing new has appeared for a minute. Rejects after
// SETTLE_TIMEOUT_MS.
//
// readdir alone may never show the entries of a directory iCloud hasn't
// enumerated yet, and nothing watches the folder now to do it (watcher and
// monitorer.js use brctl.ls for this). So each poll lists, with brctl.ls, the
// directories that should hold a missing path: the parents that are there
// now, so deeper ones follow as their parents appear.
const waitForFiles = async (blogID, before) => {
  const allowance = Math.max(2, Math.floor(before.length / 100));
  const start = Date.now();
  let lastSize = -1;
  let stableSince = start;
  let lastLog = 0;
  let turn = 0;

  for (;;) {
    // Read the layout again each time: the owner may rename the folder, and
    // nothing watches it yet. A folder changing under the walk only means
    // another look
    let now = null;
    let root = null;
    let name = null;
    try {
      ({ root, name } = await refresh(blogID));
      if (root) now = new Set(await listPaths(root));
    } catch (error) {
      console.error(clfdate(), `Migrating ${blogID}: listing:`, error.message);
    }
    const missing = now ? before.filter((path) => !now.has(path)) : before;
    if (now && !missing.length) return name;

    if (now) {
      const parents = new Set();
      for (const path of missing) {
        const parent = path.includes("/")
          ? path.slice(0, path.lastIndexOf("/"))
          : "";
        if (parent === "" || now.has(parent)) parents.add(parent);
      }
      // Take turns, so parents of files the owner removed (which never come
      // back) can't keep the others from being listed
      const queue = [...parents];
      const batch = [];
      for (let i = 0; i < Math.min(queue.length, MATERIALISE_PER_POLL); i++)
        batch.push(queue[(turn + i) % queue.length]);
      turn += MATERIALISE_PER_POLL;
      for (const parent of batch)
        await brctl.ls(parent ? join(root, parent) : root).catch(() => {});
    }

    if (!now) {
      stableSince = Date.now();
    } else if (now.size !== lastSize) {
      lastSize = now.size;
      stableSince = Date.now();
    } else if (
      missing.length <= allowance &&
      Date.now() - stableSince >= SETTLE_STABLE_MS
    ) {
      console.log(
        clfdate(),
        `Migrating ${blogID}: ${missing.length} path(s) never came back: ${missing.slice(0, 5).join(", ")}`
      );
      return name;
    }

    if (Date.now() - start > SETTLE_TIMEOUT_MS)
      throw new Error(
        `${missing.length} of ${before.length} paths still missing after ${SETTLE_TIMEOUT_MS / 60_000} minutes`
      );

    if (Date.now() - lastLog > 30_000) {
      lastLog = Date.now();
      console.log(
        clfdate(),
        `Migrating ${blogID}: waiting for ${missing.length} of ${before.length} paths`
      );
    }
    await sleep(SETTLE_POLL_MS);
  }
};

const collaborationID = async (path) => {
  try {
    return JSON.parse(await shareInfo(path)).CollaborationIdentifier || null;
  } catch {
    return null;
  }
};

// After a failed rejoin, or a rejoin that brought back some other folder:
// whatever setup left in blog_<id> is taken off this Mac (only ever the
// share Blot joined, never anyone's files), and the blog is marked as having
// lost its folder. Blot's validation and resyncs skip a blog with an error
// stored, so nothing is synced from or to the wrong folder, and the dashboard
// asks the owner to share their folder again.
const quarantine = async (blogID, reason) => {
  console.error(clfdate(), `MIGRATION FAILED for ${blogID}: ${reason}`);
  try {
    const layout = await refresh(blogID);
    if (layout.nested) {
      if (layout.root)
        await finderLimiter.schedule(() =>
          leaveFolder(layout.root, { root: iCloudDriveDirectory })
        );
      await removeContainer(blogID);
    }
  } catch (error) {
    console.error(clfdate(), `Quarantine cleanup for ${blogID}:`, error);
  }
  await status(blogID, {
    error: "Blog directory deleted",
    errorCode: "SOURCE_MISSING",
  }).catch((error) =>
    console.error(clfdate(), `Quarantine status for ${blogID}:`, error.message)
  );
};

export default async (req, res) => {
  const blogID = req.header("blogID");
  const sharingLink = req.header("sharingLink");

  if (!blogID || !/^blog_[a-zA-Z0-9]+$/.test(blogID))
    return res.status(400).send("Invalid blogID");
  if (!sharingLink) return res.status(400).send("Missing sharingLink");

  const container = join(iCloudDriveDirectory, blogID);
  if (!(await fs.pathExists(container)))
    return res.status(404).send("No folder for this blog");

  const layout = await refresh(blogID);
  if (layout.nested) return res.status(409).send("Already nested");

  const permission = await sharePermission(container, { attempts: 2 });
  if (permission !== "readWrite")
    return res.status(409).send(`Share permission is ${permission}`);

  const before = await collaborationID(container);
  if (!before || before === "(none)")
    return res.status(409).send("Not a shared folder");

  // What iCloud must list again after the rejoin before anything walks the
  // folder (waitForFiles)
  const paths = await listPaths(container);

  console.log(
    clfdate(),
    `Migrating ${blogID} to the nested layout (${paths.length} paths)`
  );

  // Not watched meanwhile: the folder is briefly gone, which the watcher
  // would otherwise report to Blot as deleted
  await unwatch(blogID);

  // Leave the share first: opening a link to a share this Mac is still in
  // brings no new folder for setup to find. Through the Finder queue setup
  // uses too, so the two never drive Finder at once
  try {
    await finderLimiter.schedule(() =>
      leaveFolder(container, { root: iCloudDriveDirectory })
    );
  } catch (error) {
    // Nothing changed: carry on as before
    console.error(clfdate(), `Migration of ${blogID} could not leave:`, error);
    await watch(blogID);
    return res.status(500).send(`Leave failed: ${error.message}`);
  }

  // Right after a participant leaves, iCloud turns the share's link away for
  // a little while ("Sorry, this folder can't be opened right now. Please try
  // again later", which setup reports as INVALID_LINK) and may be slow to
  // hand the folder over (TIMEOUT): seen on icloudtest, the link worked again
  // within about 40 s. So wait, then retry those two with growing gaps.
  // Anything else, or still failing after the last try, quarantines the blog.
  for (let attempt = 0; ; attempt++) {
    await sleep(REJOIN_DELAYS_MS[attempt]);
    try {
      // its folderName may be out of date by the end: see waitForFiles
      await setupBlog(blogID, sharingLink, (stage) =>
        console.log(clfdate(), `Migrating ${blogID}: ${stage}`)
      );
      break;
    } catch (error) {
      const retry =
        RETRYABLE.includes(error.reason) &&
        attempt + 1 < REJOIN_DELAYS_MS.length;
      console.error(
        clfdate(),
        `Migration of ${blogID}: rejoin attempt ${attempt + 1} failed (${error.reason || error.message})${retry ? ", trying again" : ""}`
      );
      if (!retry) {
        await quarantine(blogID, `rejoin failed: ${error.message}`);
        return res.status(500).send(`Rejoin failed: ${error.message}`);
      }
    }
  }

  // Setup takes the first new folder to appear. Only when it is the same
  // share does the blog sync again: another folder must never be resynced
  // into this blog, which could remove or replace its files. It stays
  // unwatched for the maintainer to look at
  let after = null;
  try {
    after = await collaborationID(rootOf(blogID));
  } catch {
    // no folder: after stays null
  }
  if (after !== before) {
    await quarantine(blogID, `another share came back (${before} -> ${after})`);
    return res
      .status(500)
      .send(`Another share came back (${after}); ${blogID} is quarantined`);
  }

  // Only then is the folder watched and resynced. Blot's migration script
  // holds the blog's sync lock meanwhile, so no validation walks it either
  let folderName;
  try {
    folderName = await waitForFiles(blogID, paths);
  } catch (error) {
    await quarantine(blogID, `files did not come back: ${error.message}`);
    return res.status(500).send(`Files did not come back: ${error.message}`);
  }

  await watch(blogID);
  await status(blogID, { folderName }).catch((error) =>
    console.error(clfdate(), `folderName for ${blogID}:`, error.message)
  );
  requestResync(blogID, "migrated to the nested layout").catch((error) =>
    console.error(clfdate(), `resync for ${blogID}:`, error.message)
  );

  console.log(clfdate(), `Migrated ${blogID} as "${folderName}"`);
  res.json({ folderName, sameShare: true });
};
