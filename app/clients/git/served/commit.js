// Blot's own write to a blog served from the git store (#2259): repo.commit's
// path for a switched blog. As on EBS, the file is written to (or removed
// from) the blog folder through storage/folder first, and then committed:
// here with the store's commit() (store/commit.js), which makes the same
// commit plumbing.js would, with the same identity, messages and refusals.
//
// The commit holds the blog's ref lock for the whole call, as plumbing.js
// does on EBS, so two of Blot's writes never lose a swap to each other; the
// store is given a lock which is already held. A push waits for the lock as
// it does for one of Blot's writes on EBS. One place in the background lane
// is taken before the lock, as repo.commit does.
//
// Then, as on EBS, the applied commit is moved from the parent to the commit
// (only if it is still the parent), and in the background the EBS fallback
// (./fallback.js) and a compaction (./upkeep.js) are asked for.
//
// An outcome of "unknown" fails the write: the commit may have landed, so
// nothing that depends on it moves, and the fallback and the next sync bring
// both sides to whatever the store holds. A store with no copy of the
// repository fails the write too, rather than starting a new history.
//
// One line per write:
//
//   [git-store-served] blog=<id> op=write outcome=ok|unchanged|unknown|error ms=...
const { promisify } = require("util");
const clfdate = require("helper/clfdate");
const storage = require("storage/folder");
const limiter = require("../limiter");
const database = require("../database");
const manifest = require("../store/manifest");
const storeCommit = require("../store/commit");
const { measure } = require("../shadow/counting");
const context = require("./context");
const fallback = require("./fallback");
const upkeep = require("./upkeep");
const log = require("./log");

const advanceApplied = promisify(database.advanceApplied.bind(database));

// change is { path, contents }, contents null to remove the file
async function commit(blogID, change) {
  const started = Date.now();
  const removing = change.contents === null || change.contents === undefined;
  const fields = { blog: blogID, op: "write" };
  let result;

  const store = context.storeFor(blogID);
  const cache = context.cache();

  // Before the folder is touched: a write the store could not take would
  // leave the folder ahead of the repository
  if (manifest.isEmpty(await manifest.read(store))) {
    log({ ...fields, outcome: "error", detail: "the store has no copy" });
    throw new Error("The git store has no copy of the repository of " + blogID);
  }

  if (removing) await storage.remove(blogID, change.path);
  else await storage.write(blogID, change.path, change.contents);

  try {
    const measured = await measure(() =>
      limiter.run("background", async function () {
        const release = await require("../repo").holdRefLock(blogID);

        try {
          return await storeCommit({
            store,
            cache,
            // Already held, for the whole call
            lock: (fn) => fn(),
            path: change.path,
            contents: removing ? undefined : change.contents,
            remove: removing,
          });
        } finally {
          await Promise.resolve()
            .then(release)
            .catch(function (err) {
              // The lock expires by itself; a commit that worked still worked
              console.error(clfdate(), "Git: could not release the ref lock of", blogID, err && err.message);
            });
        }
      })
    );

    result = measured.result;
    Object.assign(fields, { ms: Date.now() - started, requests: measured.counts.requests, bytesUp: measured.counts.bytesUp, seq: result.seq });
  } catch (err) {
    log({ ...fields, outcome: "error", ms: Date.now() - started, detail: (err && (err.code || err.name)) || "error" });
    throw err;
  }

  if (result.outcome === "unknown") {
    log({ ...fields, outcome: "unknown", detail: (result.error && (result.error.code || result.error.name)) || "unknown" });
    // What the store holds, whichever it is, reaches EBS and the folder
    fallback.request(blogID, { reason: "write" });
    throw new Error("Blot could not confirm whether the change to " + change.path + " was saved");
  }

  if (!result.changed) {
    log({ ...fields, outcome: "unchanged" });
    return result;
  }

  log({ ...fields, outcome: "ok" });

  // The repository's first commit has no parent. Redis being unavailable is
  // no reason to fail a write that is already committed: the next sync
  // applies it again, which is harmless.
  if (result.parent) {
    await advanceApplied(blogID, result.parent, result.commit).catch(function (err) {
      console.error(clfdate(), "Git: could not record the applied commit of", blogID, err && err.message);
    });
  }

  fallback.request(blogID, { reason: "write" });
  upkeep.compactAfter(blogID, result.manifest);

  return result;
}

module.exports = commit;
