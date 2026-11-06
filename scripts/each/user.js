var User = require("models/user");
var { promisify } = require("util");
var progress = require("./progress");

// The promise core. fn is (user) and may return a promise.
async function eachUser(fn) {
  var uids = await User.getAllIds();

  if (!uids) throw new Error("No uids");

  var bar = progress.push("User", uids.length);

  try {
    for (const uid of uids) {
      try {
        var user = await User.getById(uid);

        if (!user) {
          console.log("Warning: No user found for uid:", uid);
          console.log("Remove this from the set of uids to process.");
          console.log("Continuing with next user...");
          continue;
        }

        await fn(user);
      } finally {
        bar.tick();
      }
    }
  } finally {
    bar.pop();
  }
}

// Callback API, for the scripts that still pass fn(user, next).
module.exports = function (fn, callback) {
  eachUser(promisify(fn)).then(
    () => callback(null),
    (err) => callback(err)
  );
};
