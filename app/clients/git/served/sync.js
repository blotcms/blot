// The sync of a blog served from the git store (#2259), inside sync.js's
// sync(blogID) and so its folder lock: the blog folder is brought from the
// commit Blot last applied (blog:<id>:git:applied) to master in the store's
// newest manifest, by ./materialize.js, and each changed path is passed to
// Blot (folder.update, in series, as on EBS). The applied commit is moved on
// once every path has been processed; a Redis outage stops it, so the next
// sync applies the same range again, as on EBS.
//
// If the store does not have the applied commit (a force push, then a
// rewrite), the sync starts from the empty tree, as on EBS: every file is
// written, and files which should be gone stay until a resync.
//
// There is no live clone to move: a switched blog's clone, if it has one, is
// left where it is.
const { promisify } = require("util");
const database = require("../database");
const manifest = require("../store/manifest");
const createReader = require("../store/reader");
const isRedisUnavailableError = require("helper/redisUnavailable").isRedisUnavailableError;
const { EMPTY_TREE } = require("../materialize");
const materialize = require("./materialize");
const context = require("./context");

const MASTER = "refs/heads/master";

const getApplied = promisify(database.getApplied.bind(database));
const setApplied = promisify(database.setApplied.bind(database));

async function hasCommit(reader, oid) {
  try {
    const found = await reader.read(oid);
    return !!found && found.type === "commit";
  } catch (err) {
    if (err.code === "NOT_FOUND") return false;
    throw err;
  }
}

// folder is what the sync lock gives: { log, update(path, callback) }
async function sync(blogID, folder) {
  const store = context.storeFor(blogID);
  const cache = context.cache();
  const current = await manifest.read(store);

  if (manifest.isEmpty(current)) throw new Error("The git store has no copy of this repository");

  const commit = current.refs[MASTER];

  if (!commit) {
    folder.log("No master in the store, nothing to apply");
    return;
  }

  const reader = createReader({ store, cache, manifest: current, scratch: cache });
  let base = await getApplied(blogID);

  if (base && base !== EMPTY_TREE && !(await hasCommit(reader, base))) {
    folder.log(`Applied commit ${base} is not in the store, comparing from nothing`);
    base = null;
  }

  if (!base) {
    base = EMPTY_TREE;
    await setApplied(blogID, base);
  }

  if (base === commit) {
    folder.log("No changes to repo");
    return;
  }

  folder.log(`Comparing ${base} with ${commit} in the store`);

  const paths = await materialize({ blogID, reader, from: base, to: commit, log: folder.log });

  folder.log(`Found ${paths.length} changes to git repo`);
  paths.forEach((path) => folder.log("/" + path, "changed"));

  // In series until entry.set is atomic, as on EBS
  for (const path of paths) {
    const err = await new Promise((resolve) => folder.update(path, resolve));

    if (err && isRedisUnavailableError(err)) {
      folder.log("Redis unavailable, the next sync will apply these changes again");
      throw err;
    }

    if (err) console.log("Git client:", err);
  }

  folder.log(`Processed ${paths.length} changes`);
  await setApplied(blogID, commit);
}

module.exports = sync;
