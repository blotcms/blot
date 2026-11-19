// Runs a sync's update(path) for each of paths, the way a client's loop over
// its changes would, and builds up to `limit` files at once when
// config.sync.concurrent_builds is on. Off, or with a limit of 1, the paths
// are updated one at a time in the order given, as the loops this replaces
// did.
//
//   const outcomes = await updateAll(blogID, paths, folder.update);
//
// Resolves to one { path, result, error } per path, in the order of paths:
// result is what update resolved to, error what it threw. A Redis outage
// stops it: no further path is started, and once those already started have
// finished it rejects with that error, as the next sync must apply them all
// again.
//
// The default of 3 at once leaves one of the sandbox's 4 job slots to other
// blogs. While it runs:
//  - the paths in one "+" folder build the same post, so they are updated
//    one after another, in order, never at once
//  - two builds of one path never overlap, and a dependent's rebuild waits
//    for any build which might add a dependency on what changed (see
//    update/builds.js)
//  - it resolves only once the dependents' rebuilds it started have
//    finished, so none outlives the sync's folder lock
//
// The order across paths isn't kept, so a client whose updates rely on it
// (deletions before the writes which replace them, say) runs each group as
// its own call.
const config = require("config");
const build = require("build");
const eachLimit = require("helper/eachLimit");
const pathNormalizer = require("helper/pathNormalizer");
const builds = require("./update/builds");
const { isRedisUnavailableError } = require("helper/redisUnavailable");

const LIMIT = 3;

module.exports = async function updateAll(blogID, paths, update, options = {}) {
  const limit = options.limit || (config.sync.concurrent_builds ? LIMIT : 1);

  const outcomes = paths.map((path) => ({
    path,
    result: undefined,
    error: null,
  }));

  let stopped = null;

  async function run(index) {
    try {
      outcomes[index].result = await update(paths[index]);
    } catch (err) {
      outcomes[index].error = err;
      if (!stopped && isRedisUnavailableError(err)) stopped = err;
    }
  }

  if (limit <= 1) {
    for (let index = 0; index < paths.length && !stopped; index++)
      await run(index);
  } else {
    // One lane per "+" folder, and one for each other path
    const lanes = new Map();

    paths.forEach((path, index) => {
      const multiInfo = build.findMultiFolder(path);
      const lane = pathNormalizer(multiInfo ? multiInfo.folderPath : path);

      if (!lanes.has(lane)) lanes.set(lane, []);
      lanes.get(lane).push(index);
    });

    await builds.batch(blogID, () =>
      eachLimit(Array.from(lanes.values()), limit, async (lane) => {
        for (const index of lane) {
          if (stopped) return;
          await run(index);
        }
      })
    );
  }

  if (stopped) throw stopped;

  return outcomes;
};
