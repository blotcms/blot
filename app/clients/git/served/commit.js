// Blot's own write to a blog's repository in the git store (#2259):
// repo.commit. The file is written to (or removed from) the blog folder
// through storage/folder first, and then committed with the store's commit()
// (store/commit.js), with Blot's identity and messages. A change that leaves
// the tree as it is (the same contents again, or a removal of a file the
// repository doesn't have) makes no commit.
//
// The commit holds the blog's ref lock for the whole call, so two of Blot's
// writes never lose a swap to each other; the store is given a lock which is
// already held. A push waits for the lock. One place in the background lane
// is taken before the lock, so the commit never waits for room with the lock
// held, which would hold up a push to the blog.
//
// Then the applied commit is moved from the parent to the commit (only if it
// is still the parent: otherwise an earlier push has not been applied, and
// the next sync applies Blot's change again, which is harmless), and a
// compaction (./upkeep.js) is asked for in the background.
//
// An outcome of "unknown" fails the write: the commit may have landed, so
// nothing that depends on it moves, and the next sync brings the folder to
// whatever the store holds. A store with no copy of the repository fails the
// write too, before the folder is touched, rather than starting a new
// history.
//
// One line per write:
//
//   [git-store-served] blog=<id> op=write outcome=ok|unchanged|unknown|error ms=...
const clfdate = require("helper/clfdate");
const storage = require("storage/folder");
const limiter = require("../limiter");
const database = require("../database");
const manifest = require("../store/manifest");
const storeCommit = require("../store/commit");
const { measure } = require("./counting");
const context = require("./context");
const upkeep = require("./upkeep");
const log = require("./log");

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
              console.error(
                clfdate(),
                "Git: could not release the ref lock of",
                blogID,
                err && err.message
              );
            });
        }
      })
    );

    result = measured.result;
    Object.assign(fields, {
      ms: Date.now() - started,
      requests: measured.counts.requests,
      bytesUp: measured.counts.bytesUp,
      seq: result.seq,
    });
  } catch (err) {
    log({
      ...fields,
      outcome: "error",
      ms: Date.now() - started,
      detail: (err && (err.code || err.name)) || "error",
    });
    throw err;
  }

  if (result.outcome === "unknown") {
    log({
      ...fields,
      outcome: "unknown",
      detail:
        (result.error && (result.error.code || result.error.name)) || "unknown",
    });
    throw new Error(
      "Blot could not confirm whether the change to " +
        change.path +
        " was saved"
    );
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
    await database
      .advanceApplied(blogID, result.parent, result.commit)
      .catch(function (err) {
        console.error(
          clfdate(),
          "Git: could not record the applied commit of",
          blogID,
          err && err.message
        );
      });
  }

  upkeep.compactAfter(blogID, result.manifest);

  return result;
}

module.exports = commit;
