const fs = require("fs-extra");
const { join, sep } = require("path");

// Where storage/assets stages files for upload, inside config.tmp_directory:
// {tmp}/storage-assets-staging/{blogID}/{relPath}. app/scheduler/prune-tmp.js
// looks after it too.
const STAGING_DIRECTORY = "storage-assets-staging";

function isMissing(err) {
  return (
    err &&
    (err.code === "ENOENT" ||
      err.code === "ENOTDIR" ||
      err.code === "EISDIR" ||
      err.status === 404)
  );
}

// Every file under a local directory, as paths relative to it using "/",
// with no leading slash. A directory which doesn't exist has no files.
async function* walkLocal(directory) {
  async function* visit(current) {
    let entries;

    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (err) {
      if (isMissing(err)) return;
      throw err;
    }

    for (const entry of entries) {
      const full = join(current, entry.name);

      if (entry.isDirectory()) yield* visit(full);
      else if (entry.isFile())
        yield full.slice(directory.length + 1).split(sep).join("/");
    }
  }

  yield* visit(directory);
}

// Runs at most `limit` tasks at once. add(task) resolves once the task has
// been started (waiting for a free slot, which is what keeps a producer from
// racing ahead of the work) and drain() resolves when every task has
// finished. If a task rejects, the next add() or drain() rejects with the
// first such error.
function createPool(limit) {
  let active = 0;
  let failure = null;
  const waiting = [];
  const idle = [];

  function release() {
    // hand the slot straight to a waiting add() so nobody can jump the queue
    if (waiting.length) return waiting.shift()();

    active--;

    if (!active) idle.splice(0).forEach((resolve) => resolve());
  }

  async function add(task) {
    if (failure) throw failure;

    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    else active++;

    if (failure) {
      release();
      throw failure;
    }

    Promise.resolve()
      .then(task)
      .catch((err) => {
        failure = failure || err;
      })
      .then(release);
  }

  async function drain() {
    if (active) await new Promise((resolve) => idle.push(resolve));
    if (failure) throw failure;
  }

  return { add, drain };
}

module.exports = { STAGING_DIRECTORY, isMissing, walkLocal, createPool };
