var User = require("models/user");
var async = require("async");
var progress = require("./progress");

module.exports = function (fn, callback) {
  User.getAllIds(function (err, uids) {
    if (err || !uids) return callback(err || new Error("No uids"));

    var bar = progress.push("User", uids.length);

    async.eachSeries(
      uids,
      function (uid, done) {
        var next = function (err) {
          bar.tick();
          done(err);
        };

        User.getById(uid, function (err, user) {
          if (err) return next(err);

          if (!user) {
            console.log("Warning: No user found for uid:", uid);
            console.log("Remove this from the set of uids to process.");
            console.log("Continuing with next user...");
            return next();
          }

          fn(user, next);
        });
      },
      function (err) {
        bar.pop();
        callback(err);
      }
    );
  });
};
