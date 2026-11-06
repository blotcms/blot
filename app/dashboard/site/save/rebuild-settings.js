// Rebuilds a site after a change to a setting that alters how its posts are
// built (plugins, image metadata, images as posts). One rebuild at a time per
// site: a change made while one runs stops it between files, and a single
// fresh rebuild then applies every change since. The status reads
// "Applying settings 3 of 12" (js/global-sync.js shows it).
//
// It runs under the folder's sync lock, like the Folder page's Rebuild button,
// so it never overlaps a sync or another rebuild: building two paths of a
// blog at once is not safe (see sync/rebuild.js). Blue and green both take
// saves, so the bookkeeping is in Redis:
//   blog:<id>:settings-rebuild:requests   counts requests; a rebuild that sees
//                                          it change stops and starts again
//   blog:<id>:settings-rebuild:running    held by the process running them,
//                                          which takes every later request
// Both go with the blog's other keys when it is deleted.

const client = require("models/client");
const Blog = require("models/blog");
const Sync = require("sync");
const rebuild = require("sync/rebuild");

const LABEL = "Applying settings";
const RUNNING_SECONDS = 60 * 60;
// A sync holding the lock usually finishes within seconds; wait that long
const LOCK_RETRY_MS = 3000;
const LOCK_GIVE_UP_MS = 15 * 60 * 1000;

const key = (blogID, name) => `blog:${blogID}:settings-rebuild:${name}`;

// Stores the status before returning, so the page the save redirects to (or
// the page that saved in the background) shows the rebuild straight away
module.exports = async function requestRebuild(blogID) {
  await client.incr(key(blogID, "requests"));
  await new Promise((resolve) =>
    Blog.setStatus(blogID, { message: LABEL }, () => resolve())
  );
  client.publish("sync:status:" + blogID, LABEL).catch(() => {});

  run(blogID).catch((err) =>
    console.log("Settings rebuild failed", blogID, err.message)
  );
};

async function run(blogID) {
  const running = key(blogID, "running");
  const requests = key(blogID, "requests");

  // Another process is running them and will see this request
  if (!(await client.set(running, "1", { NX: true, EX: RUNNING_SECONDS })))
    return;

  let handled;

  try {
    handled = await underLock(blogID, async (folder) => {
      // "(3/12) Rebuilding /path" -> "(3/12) Applying settings"
      const status = (message) =>
        folder.status(
          message.replace(/^(\(\d+\/\d+\)) Rebuilding\b.*$/, "$1 " + LABEL)
        );

      let current;

      do {
        current = await client.get(requests);
        await new Promise((resolve, reject) =>
          rebuild(
            blogID,
            {
              thumbnails: false, // do not re-generate thumbnails
              imageCache: false, // do not re-cache images in posts
              status,
              log: folder.log,
              shouldStop: async () => (await client.get(requests)) !== current,
            },
            (err) => (err ? reject(err) : resolve())
          )
        );
      } while ((await client.get(requests)) !== current);

      return current;
    });
  } finally {
    await client.del(running);
  }

  // A request that came in after the last check, while this one still held
  // the running key, would otherwise wait for the next change
  if ((await client.get(requests)) !== handled) return run(blogID);
}

// Runs fn(folder) holding the folder's sync lock; waits while a sync has it
function underLock(blogID, fn) {
  const started = Date.now();

  return new Promise((resolve, reject) => {
    (function attempt() {
      Sync(blogID, (err, folder, done) => {
        if (err) {
          if (Date.now() - started > LOCK_GIVE_UP_MS) return reject(err);
          return setTimeout(attempt, LOCK_RETRY_MS);
        }

        folder.status(LABEL);

        fn(folder).then(
          (result) =>
            done(null, (err) => (err ? reject(err) : resolve(result))),
          (err) =>
            done(err, () => {
              folder.status("Error applying settings");
              reject(err);
            })
        );
      });
    })();
  });
}
