import fs from "fs-extra";
import * as brctl from "./brctl/index.js";
import { syncedUp } from "./birdState.js";
import clfdate from "./util/clfdate.js";

// A file Blot writes into a blog folder (a template, an edited post) is
// downloaded, and FileProvider holds a remote edit to a downloaded file until
// it has fetched the new version: tens of seconds, against a tenth of a second
// for an evicted file (see evictAfterPush in httpClient/upload.js). So once
// iCloud has Blot's version, the local copy is evicted, and the customer's
// next edit to it reaches the macserver at once.
//
// Evicting before the upload has finished would leave iCloud without the
// file, so this waits for bird to report it synced up. It gives up when the
// file changes or goes (that edit is pushed and evicted as usual), when
// another write to the path takes over, after MAX_WAIT_MS, or when bird's
// database can't say.
const POLL_MS = 5_000;
const MAX_WAIT_MS = 10 * 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waiting = new Map(); // filePath -> token of the latest write

const sameVersion = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs;

export default function evictWhenUploaded(
  blogID,
  pathInBlogDirectory,
  filePath,
  stat,
  { pollMs = POLL_MS, maxWaitMs = MAX_WAIT_MS } = {}
) {
  const token = {};
  waiting.set(filePath, token);

  const run = async () => {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      await sleep(pollMs);
      if (waiting.get(filePath) !== token) return;

      const now = await fs.stat(filePath).catch(() => null);
      if (!now || !sameVersion(now, stat)) return;

      const done = await syncedUp(blogID, pathInBlogDirectory, stat.size);
      if (done === null) return;
      if (done) {
        await brctl.evict(filePath);
        return;
      }
    }
    console.warn(
      clfdate(),
      `Not evicting Blot's write, iCloud has not taken it after ${maxWaitMs}ms: ${filePath}`
    );
  };

  return run()
    .catch((error) =>
      console.warn(
        clfdate(),
        `Could not evict Blot's write: ${filePath}`,
        error
      )
    )
    .finally(() => {
      if (waiting.get(filePath) === token) waiting.delete(filePath);
    });
}
