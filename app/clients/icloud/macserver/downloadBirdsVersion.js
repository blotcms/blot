import fs from "fs-extra";
import * as brctl from "./brctl/index.js";
import { fileVersion, diskMatches } from "./birdState.js";
import clfdate from "./util/clfdate.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How long to wait for the disk to reach the version bird has before pushing
// whatever the disk holds, how often to ask for the download again meanwhile,
// and how long to give a new file whose record bird created empty (its data
// can follow a moment later).
const CATCH_UP_MS = 60 * 1000;
const FORCE_DOWNLOAD_EVERY_MS = 5 * 1000;
const EMPTY_RECORD_WAIT_MS = 5 * 1000;

// Whether a stat is of a downloaded file: its blocks cover its size, as
// brctl/download.js judges it. A zero-byte file counts as downloaded.
const isDownloaded = (stat) =>
  stat.size === 0 ||
  stat.blocks >= Math.ceil(Math.ceil(stat.size / 512) / 8) * 8;

// Downloads the file, then makes sure the disk holds the version bird has.
// bird learns about a change before FileProvider updates the file: an edit to
// a downloaded file can take tens of seconds to reach the disk, and pushing
// before then sends Blot the old version. Resolves to the stat of the file
// that will be pushed. Without bird's database this is just the download.
export default async function downloadBirdsVersion(blogID, path, filePath) {
  const start = Date.now();
  let version = await fileVersion(blogID, path);

  if (version && version.size === 0) {
    while (Date.now() - start < EMPTY_RECORD_WAIT_MS) {
      await sleep(500);
      version = (await fileVersion(blogID, path)) || version;
      if (version.size !== 0) break;
    }
  }

  let stat = await brctl.download(filePath);
  let lastForced = 0;
  let failure = null;

  // bird's version, downloaded: a placeholder with the right size and mtime
  // is not ready, and reading it would block until iCloud delivers it
  while (version && !(diskMatches(version, stat) && isDownloaded(stat))) {
    if (Date.now() - start > CATCH_UP_MS) {
      if (!isDownloaded(stat)) {
        throw failure || new Error(`Timeout downloading file: ${filePath}`);
      }
      console.warn(
        clfdate(),
        `Disk still behind bird after ${CATCH_UP_MS}ms, pushing what is on disk: ${filePath}`,
        { disk: { size: stat.size, mtimeMs: stat.mtimeMs }, bird: version }
      );
      return stat;
    }

    const force = Date.now() - lastForced > FORCE_DOWNLOAD_EVERY_MS;
    if (force) {
      lastForced = Date.now();
      console.log(clfdate(), `Disk is behind bird, fetching: ${filePath}`, {
        disk: { size: stat.size, mtimeMs: stat.mtimeMs },
        bird: version,
      });
    } else {
      await sleep(250);
    }

    try {
      stat = await brctl.download(filePath, { force });
      failure = null;
    } catch (error) {
      // the file is gone (renamed or deleted): the caller handles that
      if (!(await fs.pathExists(filePath))) throw error;
      console.warn(
        clfdate(),
        `Download while catching up failed: ${filePath}`,
        error.message
      );
      failure = error;
      stat = await fs.stat(filePath);
    }
    version = (await fileVersion(blogID, path)) || version;
  }

  return stat;
}
