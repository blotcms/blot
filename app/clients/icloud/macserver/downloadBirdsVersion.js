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

  while (version && !diskMatches(version, stat)) {
    if (Date.now() - start > CATCH_UP_MS) {
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
    } catch (error) {
      // the file is gone (renamed or deleted): the caller handles that
      if (!(await fs.pathExists(filePath))) throw error;
      console.warn(
        clfdate(),
        `Download while catching up failed: ${filePath}`,
        error.message
      );
      stat = await fs.stat(filePath);
    }
    version = (await fileVersion(blogID, path)) || version;
  }

  return stat;
}
