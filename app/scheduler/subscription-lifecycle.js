var clfdate = require("helper/clfdate");
var User = require("models/user");
var eachUser = require("../../scripts/each/user");
var email = require("helper/email");
var subscriptionLifecycle = require("models/user/subscriptionLifecycle");

function deleteUserAccount(user, callback) {
  void user;
  // Safety rollout: temporarily keep this as a no-op so we can verify
  // subscription lifecycle behavior in production before permanently
  // deleting user data.
  callback();
}

function periodEndedAtISO(details) {
  return details.periodEndedAt
    ? new Date(details.periodEndedAt).toISOString()
    : "unknown";
}

function daysAgo(ms) {
  return Math.floor((Date.now() - ms) / (24 * 60 * 60 * 1000));
}

module.exports = function processSubscriptionLifecycle(callback) {
  callback = callback || function () {};

  var disabled = 0;
  var deleted = 0;
  var enabled = 0;
  var usersToRemove = [];

  function queueCancelledDeletion(user, details, next) {
    if (!subscriptionLifecycle.deletionDue(user)) return next();

    var periodEndedAtMs = details.periodEndedAt;

    usersToRemove.push({
      email: user.email,
      reason:
        "cancelled on " +
        periodEndedAtISO(details) +
        (periodEndedAtMs
          ? " (" + daysAgo(periodEndedAtMs) + " days ago)"
          : ""),
    });

    deleteUserAccount(user, function (deleteErr) {
      if (deleteErr) return next(deleteErr);

      deleted += 1;
      next();
    });
  }

  function queueOverdueDeletion(user, overdue, overdueStartedAtISO, next) {
    usersToRemove.push({
      email: user.email,
      reason:
        "overdue on " +
        overdueStartedAtISO +
        (overdue.startedAt
          ? " (" + daysAgo(overdue.startedAt) + " days ago)"
          : ""),
    });

    deleteUserAccount(user, function (deleteErr) {
      if (deleteErr) return next(deleteErr);

      deleted += 1;
      next();
    });
  }

  eachUser(
    function (user, next) {
      var overdue = subscriptionLifecycle.overdueDetails(user);

      if (overdue.overdue) {
        var overdueStartedAtISO = overdue.startedAt
          ? new Date(overdue.startedAt).toISOString()
          : "unknown";

        if (overdue.phase === "grace_active") {
          console.log(
            clfdate(),
            "Subscription lifecycle overdue phase=grace_active",
            user.email,
            "startedAt=" + overdueStartedAtISO
          );

          if (!user.isDisabled) return next();

          return User.enable(user, function (enableErr) {
            if (enableErr) return next(enableErr);

            enabled += 1;

            email.OVERDUE_SUBSCRIPTION_GRACE_ACTIVE("", {
              email: user.email,
              subscriptionOverdueOn: overdueStartedAtISO,
            });

            next();
          });
        }

        if (overdue.phase === "disabled_grace") {
          console.log(
            clfdate(),
            "Subscription lifecycle overdue phase=disabled_grace",
            user.email,
            "startedAt=" + overdueStartedAtISO
          );

          if (user.isDisabled) return next();

          return User.disable(user, function (disableErr) {
            if (disableErr) return next(disableErr);

            disabled += 1;

            email.OVERDUE_SUBSCRIPTION_DISABLED_GRACE("", {
              email: user.email,
              subscriptionOverdueOn: overdueStartedAtISO,
            });

            next();
          });
        }

        console.log(
          clfdate(),
          "Subscription lifecycle overdue phase=deletion_flow",
          user.email,
          "startedAt=" + overdueStartedAtISO
        );

        return queueOverdueDeletion(user, overdue, overdueStartedAtISO, next);
      }

      var details = subscriptionLifecycle.cancellationDetails(user);

      if (!details.cancelled || !details.periodEnded) return next();

      if (!user.isDisabled) {
        return User.disable(user, function (disableErr) {
          if (disableErr) return next(disableErr);
          disabled += 1;
          queueCancelledDeletion(user, details, next);
        });
      }

      queueCancelledDeletion(user, details, next);
    },
    function (err) {
      if (err) {
        console.log(clfdate(), "Subscription lifecycle job failed", err);
        return callback(err);
      }

      console.log(
        clfdate(),
        "Subscription lifecycle job complete",
        "enabled=" + enabled,
        "disabled=" + disabled,
        "deleted=" + deleted
      );

      if (!usersToRemove.length) return callback();

      email.USERS_DUE_FOR_REMOVAL(
        "",
        {
          users: usersToRemove,
          count: usersToRemove.length,
          singular: usersToRemove.length === 1,
        },
        function (emailErr) {
          // Log and swallow: the lifecycle work already succeeded by this
          // point, so a transient email failure shouldn't fail the job.
          if (emailErr) {
            console.log(
              clfdate(),
              "Subscription lifecycle job failed to send users-to-remove summary",
              emailErr
            );
          }

          callback();
        }
      );
    }
  );
};
