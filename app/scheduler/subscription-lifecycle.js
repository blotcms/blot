var clfdate = require("helper/clfdate");
var User = require("models/user");
var eachUser = require("../../scripts/each/user");
var email = require("helper/email");
var subscriptionLifecycle = require("models/user/subscriptionLifecycle");
var removal = require("models/user/removal");

function deleteUserAccount(user, callback) {
  void user;
  // Safety rollout: temporarily keep this as a no-op so we can verify
  // subscription lifecycle behavior in production before permanently
  // deleting user data.
  callback();
}

module.exports = function processSubscriptionLifecycle(callback) {
  callback = callback || function () {};

  var disabled = 0;
  var deleted = 0;
  var usersToRemove = [];

  // Records the user as due for removal if they've passed their grace period.
  // The decision lives in models/user/removal so it matches
  // scripts/user/delete-users-to-remove.js.
  function queueRemoval(user, overdue, next) {
    var candidate = removal.removalCandidate(user, overdue);

    if (!candidate) return next();

    usersToRemove.push({
      email: user.email,
      reason: candidate.description,
    });

    deleteUserAccount(user, function (deleteErr) {
      if (deleteErr) return next(deleteErr);

      deleted += 1;
      next();
    });
  }

  function processUser(user, overdue, next) {
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

        // Nothing to do. This job never re-enables accounts: it can't tell
        // an account disabled for being overdue from one disabled by hand.
        return next();
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

      if (!user.isDisabled) {
        return User.disable(user, function (disableErr) {
          if (disableErr) return next(disableErr);
          disabled += 1;
          queueRemoval(user, overdue, next);
        });
      }

      return queueRemoval(user, overdue, next);
    }

    var details = subscriptionLifecycle.cancellationDetails(user);

    if (!details.cancelled || !details.periodEnded) return next();

    if (!user.isDisabled) {
      return User.disable(user, function (disableErr) {
        if (disableErr) return next(disableErr);
        disabled += 1;
        // PayPal stays CANCELLED through the end of the paid period, so the
        // cancellation webhook does not close the account. Email when this
        // job is what disables it. Stripe already emails from its webhook.
        if (
          details.provider === "paypal" &&
          user.paypal &&
          String(user.paypal.status).toUpperCase() === "CANCELLED"
        )
          email.CLOSED(user.uid);
        queueRemoval(user, overdue, next);
      });
    }

    queueRemoval(user, overdue, next);
  }

  eachUser(
    function (user, next) {
      removal.overdueFor(user, function (err, overdue) {
        // A Stripe hiccup for one unpaid user shouldn't stop the whole job
        // (or the removal email); they'll be picked up on the next run.
        if (err) {
          console.log(
            clfdate(),
            "Subscription lifecycle could not check overdue status",
            user.email,
            err
          );
          return next();
        }

        // Likewise for a failed disable or removal: log it and move on so
        // the rest of the users (and the removal email) still get processed.
        processUser(user, overdue, function (processErr) {
          if (processErr) {
            console.log(
              clfdate(),
              "Subscription lifecycle could not process user",
              user.email,
              user.uid,
              processErr
            );
          }

          next();
        });
      });
    },
    function (err) {
      if (err) {
        console.log(clfdate(), "Subscription lifecycle job failed", err);
        return callback(err);
      }

      console.log(
        clfdate(),
        "Subscription lifecycle job complete",
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
