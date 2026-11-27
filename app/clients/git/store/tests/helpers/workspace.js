// A spec's temporary directories and caches, which it cleans up by itself, so
// a spec can't forget to. Call it inside a describe:
//
//   const workspace = require("./helpers/workspace");
//
//   describe("…", function () {
//     const ws = workspace.each(); // cleaned up after each spec
//     let dir, cache;
//
//     beforeEach(function () {
//       dir = ws.dir();
//       cache = ws.cache({ dir: path.join(dir, "cache"), maxBytes });
//     });
//   });
//
// workspace.all() is the same for what a beforeAll makes, cleaned up after the
// describe's last spec.
//
// The cleanup closes the caches this workspace opened, then removes its
// directories. A cache publishes its counts (a process file under procs/) after
// each reservation and on a timer, and can walk its directory in the
// background, so removing the directory under an open cache can fail with
// ENOTEMPTY; close() flushes the last publish, stops the timers and waits for a
// walk. Only this workspace's caches are closed, never an outer describe's.
const fs = require("fs");
const os = require("os");
const path = require("path");
const createCache = require("../../cache");

function workspace(register) {
  const dirs = [];
  const caches = [];

  register(async function () {
    const opened = caches.splice(0);
    const made = dirs.splice(0);
    await Promise.all(opened.map((cache) => cache.close()));
    for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
  });

  return {
    // A new empty directory, removed by the cleanup
    dir(prefix = "git-store-spec-") {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      dirs.push(dir);
      return dir;
    },

    // A directory made some other way, removed by the cleanup
    track(dir) {
      dirs.push(dir);
      return dir;
    },

    // A cache (store/cache.js), closed by the cleanup before any directory goes
    cache(options) {
      const cache = createCache(options);
      caches.push(cache);
      return cache;
    },
  };
}

module.exports = {
  each: () => workspace(afterEach),
  all: () => workspace(afterAll),
};
