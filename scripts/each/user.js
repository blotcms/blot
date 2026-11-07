var User = require("models/user");
var progress = require("./progress");

// Calls fn(user) for every user in turn. fn may be async; a rejection stops
// the run.
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

module.exports = eachUser;
