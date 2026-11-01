// The few git commands the specs run in a clone, with the names and the
// promise-or-callback shape they were written with. Each one is just the git
// command line of the same name, run with the client's own git wrapper
// (../../git.js). Any other command goes through raw(args).
var Git = require("clients/git/git");

module.exports = function (directory) {
  var git = Git(directory);

  // command is the start of the git command line; args are the arguments the
  // spec passed, which may end in a callback. Without a callback a promise
  // is returned.
  function run(command, args) {
    args = [].slice.call(args);

    var callback =
      typeof args[args.length - 1] === "function" ? args.pop() : undefined;

    return git.raw(command.concat(args), callback);
  }

  var commands = {
    // Specs were written to call this, so it stays; there is nothing to silence
    silent: function () {
      return commands;
    },
    raw: function (args, callback) {
      return git.raw(args, callback);
    },
    init: function () {
      return run(["init"], arguments);
    },
    addRemote: function () {
      return run(["remote", "add"], arguments);
    },
    clone: function () {
      return run(["clone"], arguments);
    },
    add: function () {
      return run(["add"], arguments);
    },
    commit: function () {
      return run(["commit", "-m"], arguments);
    },
    push: function () {
      return run(["push"], arguments);
    },
    pull: function () {
      return run(["pull"], arguments);
    },
    addTag: function () {
      return run(["tag"], arguments);
    },
    checkoutLocalBranch: function () {
      return run(["checkout", "-b"], arguments);
    },
    remote: function (args, callback) {
      return git.raw(["remote"].concat(args), callback);
    },
    revparse: async function (args) {
      return (await git.raw(["rev-parse"].concat(args))).trim();
    },
  };

  return commands;
};
