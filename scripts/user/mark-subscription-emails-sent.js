// Marks the subscription warning emails the old in-process timers already
// sent, so the first daily scan doesn't send them again. Run once BEFORE the
// deploy that adds the scan: every user whose warning date has passed but
// whose billing period hasn't ended yet would otherwise be emailed again.
// Safe to run again.
//
//   node scripts/user/mark-subscription-emails-sent.js

var User = require("models/user");
var lock = require("helper/lock");
var async = require("async");
var subscriptionEmail = require("models/user/scheduleSubscriptionEmail");

User.getAllIds(function (err, uids) {
  if (err) throw err;

  var marked = 0;

  async.eachSeries(
    uids,
    function (uid, next) {
      User.getById(uid, function (err, user) {
        if (err) return next(err);

        var decision = subscriptionEmail.decide(user);

        if (!decision) return next();

        lock
          .once(
            subscriptionEmail.sentKey(uid, decision.periodEnd),
            subscriptionEmail.SENT_MARKER_TTL_MS
          )
          .then(function (won) {
            if (won) marked++;
            next();
          }, next);
      });
    },
    function (err) {
      if (err) throw err;
      console.log("Marked", marked, "subscription emails as already sent");
      process.exit();
    }
  );
});
