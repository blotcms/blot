var sync = require("../index");

// The purpose of this code is to test the feature
// that sync will release any locks held by a particular
// process when the process dies. This process should die
// due to an error inside the sync function...
process.on("message", function (message) {
  console.log("Message recieved!");
  sync(message, function () {
    console.log("Acquired lock....");
    // The purpose of this file is to simulate bad code
    // invoked in the function passed to sync. We
    // want to ensure that all locks created by the process
    // are unlocked before it dies. The throw is uncaught, so
    // the process dies while the sync still holds the lock.
    setImmediate(function () {
      throw new Error("uncaughtException simulation!");
    });
    return new Promise(function () {});
  });
});
