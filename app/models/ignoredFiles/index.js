module.exports = (function () {
  var redis = require("models/client"),
    normalize = require("helper/pathNormalizer"),
    ensure = require("helper/ensure"),
    withCallback = require("helper/withCallback"),
    REASONS = {
      TOO_LARGE: {
        message: "too large",
        url: "/help",
      },
      WRONG_TYPE: {
        message: "not a file Blot can process",
        url: "/help",
      },
      PUBLIC_FILE: {
        message: "a public file",
        url: "/help",
      },
    };

  // Each of these takes an optional callback (withCallback) and otherwise
  // returns a promise

  var add = withCallback(async function add(blogID, path, reason) {
    ensure(blogID, "string").and(path, "string").and(reason, "string");

    path = normalize(path);

    await redis.hSet(ignoredFilesKey(blogID), path, reason);
  });

  var drop = withCallback(async function drop(blogID, path) {
    ensure(blogID, "string").and(path, "string");

    path = normalize(path);

    await redis.hDel(ignoredFilesKey(blogID), path);
  });

  var get = withCallback(async function get(blogID) {
    ensure(blogID, "string");

    var ignoredFiles = await redis.hGetAll(ignoredFilesKey(blogID));

    return ignoredFiles || {};
  });

  var flush = withCallback(async function flush(blogID) {
    ensure(blogID, "string");

    await redis.del(ignoredFilesKey(blogID));
  });

  var getArray = withCallback(async function getArray(blogID) {
    ensure(blogID, "string");

    var ignoredFiles = await get(blogID);
    var ignoredFileList = [];

    for (var path in ignoredFiles) {
      var reasonCode = ignoredFiles[path];
      var reason = REASONS[reasonCode] && REASONS[reasonCode].message;
      var url = REASONS[reasonCode] && REASONS[reasonCode].url;

      if (reason)
        ignoredFileList.push({
          path: path.slice(1),
          reason: reason,
          url: url,
        });
    }

    return ignoredFileList;
  });

  // Look up the ignored status for a specific set of paths in one round
  // trip, rather than transferring the entire ignored-files hash. Returns
  // an object mapping normalized path -> reason for the paths that are
  // ignored (paths that aren't ignored are omitted).
  var getStatuses = withCallback(async function getStatuses(blogID, paths) {
    ensure(blogID, "string").and(paths, "array");

    if (!paths.length) return {};

    var normalizedPaths = paths.map(normalize);

    var reasons = await redis.hmGet(ignoredFilesKey(blogID), normalizedPaths);
    var result = {};
    normalizedPaths.forEach(function (path, i) {
      if (reasons[i]) result[path] = reasons[i];
    });

    return result;
  });

  var getStatus = withCallback(async function getStatus(blogID, path) {
    ensure(blogID, "string").and(path, "string");

    path = normalize(path);

    return await redis.hGet(ignoredFilesKey(blogID), path);
  });

  var isIt = withCallback(async function isIt(blogID, path) {
    ensure(blogID, "string").and(path, "string");

    path = normalize(path);

    var exists = await redis.hExists(ignoredFilesKey(blogID), path);

    return !!exists;
  });

  function ignoredFilesKey(blogID) {
    return "blog:" + blogID + ":ignored_files";
  }

  return {
    add: add,
    drop: drop,
    get: get,
    getArray: getArray,
    getStatus: getStatus,
    getStatuses: getStatuses,
    isIt: isIt,
    flush: flush,
  };
})();
