module.exports = (function () {
  var redis = require("models/client"),
    normalize = require("helper/pathNormalizer"),
    ensure = require("helper/ensure"),
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

  function add(blogID, path, reason, callback) {
    ensure(blogID, "string")
      .and(path, "string")
      .and(reason, "string")
      .and(callback, "function");

    path = normalize(path);

    (async function () {
      try {
        await redis.hSet(ignoredFilesKey(blogID), path, reason);
        callback();
      } catch (err) {
        callback(err);
      }
    })();
  }

  function drop(blogID, path, callback) {
    ensure(blogID, "string").and(path, "string").and(callback, "function");

    path = normalize(path);

    (async function () {
      try {
        await redis.hDel(ignoredFilesKey(blogID), path);
        callback();
      } catch (err) {
        callback(err);
      }
    })();
  }

  function get(blogID, callback) {
    ensure(blogID, "string").and(callback, "function");

    (async function () {
      try {
        var ignoredFiles = await redis.hGetAll(ignoredFilesKey(blogID));
        callback(null, ignoredFiles || {});
      } catch (error) {
        callback(error);
      }
    })();
  }

  function flush(blogID, callback) {
    ensure(blogID, "string").and(callback, "function");

    (async function () {
      try {
        await redis.del(ignoredFilesKey(blogID));
        callback();
      } catch (err) {
        callback(err);
      }
    })();
  }

  function getArray(blogID, callback) {
    ensure(blogID, "string").and(callback, "function");

    get(blogID, function (err, ignoredFiles) {
      if (err) return callback(err);

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

      callback(null, ignoredFileList);
    });
  }

  // Look up the ignored status for a specific set of paths in one round
  // trip, rather than transferring the entire ignored-files hash. Returns
  // an object mapping normalized path -> reason for the paths that are
  // ignored (paths that aren't ignored are omitted).
  function getStatuses(blogID, paths, callback) {
    ensure(blogID, "string").and(paths, "array").and(callback, "function");

    if (!paths.length) return callback(null, {});

    var normalizedPaths = paths.map(normalize);

    (async function () {
      try {
        var reasons = await redis.hmGet(
          ignoredFilesKey(blogID),
          normalizedPaths
        );
        var result = {};
        normalizedPaths.forEach(function (path, i) {
          if (reasons[i]) result[path] = reasons[i];
        });
        callback(null, result);
      } catch (err) {
        callback(err);
      }
    })();
  }

  function getStatus(blogID, path, callback) {
    ensure(blogID, "string").and(path, "string").and(callback, "function");

    path = normalize(path);

    (async function () {
      try {
        var status = await redis.hGet(ignoredFilesKey(blogID), path);
        callback(null, status);
      } catch (err) {
        callback(err);
      }
    })();
  }

  function isIt(blogID, path, callback) {
    ensure(blogID, "string").and(path, "string").and(callback, "function");

    path = normalize(path);

    (async function () {
      try {
        var exists = await redis.hExists(ignoredFilesKey(blogID), path);
        return callback(null, !!exists);
      } catch (err) {
        return callback(err);
      }
    })();
  }

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
