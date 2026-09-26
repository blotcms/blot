var moment = require("moment");
var subscriptionLifecycle = require("./subscriptionLifecycle");
var overdueSince = require("./overdueSince");

// True when Stripe reports the subscription's collection is paused (e.g. an
// admin paused it by hand on Stripe to keep a site around without billing
// it). This is Stripe's own field on the cached subscription, refreshed by
// the subscription webhook - nothing we set ourselves. A paused account
// should never be treated as overdue or cancelled, whatever its stale status
// says from before the pause.
function isPaused(user) {
  return Boolean(
    user && user.subscription && user.subscription.pause_collection
  );
}

// Overdue details for a user, measured from when they actually went overdue.
// Only unpaid users cost a Stripe lookup (see overdueSince).
function overdueFor(user, callback) {
  if (isPaused(user)) {
    return callback(null, { overdue: false, startedAt: null, phase: null });
  }

  overdueSince(user, function (err, startedAt) {
    if (err) return callback(err);

    callback(null, subscriptionLifecycle.overdueDetails(user, Date.now(), startedAt));
  });
}

// Decides whether a user has passed their grace period and is due for removal,
// given the result of overdueFor. Shared by the daily scheduler job and
// scripts/user/delete-users-to-remove.js so they can't disagree.
function removalCandidate(user, overdue) {
  if (isPaused(user)) return null;

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
  isPaused: isPaused,
  overdueFor: overdueFor,
  removalCandidate: removalCandidate,
};
