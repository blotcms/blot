// A thin wrapper around child_process.execFile("git", args) for running git
// in one directory. It replaces simple-git and keeps the parts of simple-git's
// behaviour that this client depends on:
//
//   - Git(directory) throws if the directory does not exist, so callers can
//     tell a missing blog folder from a git failure.
//   - Commands on one instance run one at a time, in the order they were
//     asked for. create.js relied on this (it ran with maxConcurrentProcesses:
//     1 and fires several `git config` commands at once).
//   - A command fails only if git exited non-zero AND wrote to stderr.
//     `git commit` with nothing to commit exits 1 but prints to stdout, which
//     write.js relies on being a success, as is `git config --unset` of a key
//     that is not set.
//   - A failure's message is git's stdout followed by its stderr, so callers
//     can match on git's own wording (create.js, remove.js).
//   - Output is returned exactly as git wrote it. Callers trim.
//
// Arguments are always an array and there is no shell. There is no chaining
// API: use raw(args), which returns a promise, or calls back with
// (err, stdout) when given a callback.

const { execFile } = require("child_process");
const fs = require("fs");

// execFile's default of 1MB is too small for `ls-tree -r -z` or `diff -z` on
// a large repository, and simple-git had no limit. A string longer than about
// 512M characters cannot be built anyway, so this is a ceiling, not a buffer:
// memory is only used as output arrives.
const MAX_BUFFER = 512 * 1024 * 1024;

function isDirectory(directory) {
  try {
    return fs.statSync(directory).isDirectory();
  } catch (err) {
    return false;
  }
}

module.exports = function Git(directory, options) {
  options = options || {};

  if (typeof directory !== "string" || !isDirectory(directory)) {
    throw new Error(
      "Cannot use git in a directory that does not exist: " + directory
    );
  }

  // options.env is added to this process's environment (create.js uses it to
  // set GIT_CEILING_DIRECTORIES)
  const env = options.env ? { ...process.env, ...options.env } : process.env;

  // Each command starts when the one before it has finished
  let queue = Promise.resolve();

  function run(args) {
    return new Promise(function (resolve, reject) {
      execFile(
        "git",
        args,
        { cwd: directory, env: env, encoding: "utf8", maxBuffer: MAX_BUFFER },
        function (err, stdout, stderr) {
          if (!err) return resolve(stdout);

          // git could not be started, was killed, or printed too much: there
          // is no exit status of git's own to look at
          if (typeof err.code !== "number") return reject(err);

          // Exited non-zero without writing to stderr: not a failure
          if (!stderr) return resolve(stdout);

          const failure = new Error(stdout + stderr);
          failure.exitCode = err.code;
          reject(failure);
        }
      );
    });
  }

  return {
    raw: function raw(args, callback) {
      if (!Array.isArray(args)) {
        throw new Error("git arguments must be an array");
      }

      const result = queue.then(function () {
        return run(args);
      });

      // A failed command does not stop the ones queued after it
      queue = result.catch(function () {});

      if (typeof callback !== "function") return result;

      result.then(
        function (stdout) {
          process.nextTick(callback, null, stdout);
        },
        function (err) {
          process.nextTick(callback, err);
        }
      );
    },
  };
};
