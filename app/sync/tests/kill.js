var sync = require("../index");

// The purpose of this code is to test the feature
// that sync will release any locks held by a particular
// process when the process dies. This ensures that blogs
// continue to sync even if some error or deployment
// means we need to kill a process while a sync is ongoing.
process.on("message", function (message) {
  // Holds the lock until the process is killed
  sync(message, function () {
    process.send({ success: true });
    return new Promise(function () {});
  }).catch(function (error) {
    process.send({ error: error });
  });
});
