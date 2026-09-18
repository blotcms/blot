var moment = require("moment");
var subscriptionLifecycle = require("./subscriptionLifecycle");
var overdueSince = require("./overdueSince");

// Overdue details for a user, measured from when they actually went overdue.
// Only unpaid users cost a Stripe lookup (see overdueSince).
function overdueFor(user, callback) {
  overdueSince(user, function (err, startedAt) {
    if (err) return callback(err);

    callback(null, subscriptionLifecycle.overdueDetails(user, Date.now(), startedAt));
  });
}

// Decides whether a user has passed their grace period and is due for removal,
// given the result of overdueFor. Shared by the daily scheduler job and
// scripts/user/delete-users-to-remove.js so they can't disagree.
function removalCandidate(user, overdue) {
  var details = subscriptionLifecycle.cancellationDetails(user);

  if (
    details.cancelled &&
    details.periodEnded &&
    subscriptionLifecycle.deletionDue(user)
  ) {
    return {
      user: user,
      reason: "cancelled",
      description:
        "cancelled, subscription period ended " +
        moment(details.periodEndedAt).fromNow() +
        " (" +
        new Date(details.periodEndedAt).toISOString() +
        "), provider=" +
        details.provider,
    };
  }

  if (overdue && overdue.overdue && overdue.phase === "deletion_flow") {
    return {
      user: user,
      reason: "overdue",
      description:
        "overdue since " +
        moment(overdue.startedAt).fromNow() +
        " (" +
        new Date(overdue.startedAt).toISOString() +
        ")",
    };
  }

  return null;
}

module.exports = {
  overdueFor: overdueFor,
  removalCandidate: removalCandidate,
};
