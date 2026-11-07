var { promisify } = require("util");
var clfdate = require("helper/clfdate");
var User = require("models/user");
var eachUser = require("../../scripts/each/user");
var email = require("helper/email");
var subscriptionLifecycle = require("models/user/subscriptionLifecycle");
var removal = require("models/user/removal");

async function deleteUserAccount(user) {
  void user;
  // Safety rollout: temporarily keep this as a no-op so we can verify
  // subscription lifecycle behavior in production before permanently
  // deleting user data.
}

module.exports = async function processSubscriptionLifecycle() {
  var disabled = 0;
  var deleted = 0;
  var usersToRemove = [];

  // Records the user as due for removal if they've passed their grace period.
  // The decision lives in models/user/removal so it matches
  // scripts/user/delete-users-to-remove.js.
  async function queueRemoval(user, overdue) {
    var candidate = removal.removalCandidate(user, overdue);

    if (!candidate) return;

    usersToRemove.push({
      email: user.email,
      reason: candidate.description,
    });

    await deleteUserAccount(user);

    deleted += 1;
  }

  async function processUser(user, overdue) {
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
        return;
      }

      if (overdue.phase === "disabled_grace") {
        console.log(
          clfdate(),
          "Subscription lifecycle overdue phase=disabled_grace",
          user.email,
          "startedAt=" + overdueStartedAtISO
        );

        if (user.isDisabled) return;

        await User.disable(user);

        disabled += 1;

        // OVERDUE_CLOSURE tells both the user and the admin, so no
        // separate admin-only email is sent for the same event.
        email.OVERDUE_CLOSURE(user.uid);

        return;
      }

      console.log(
        clfdate(),
        "Subscription lifecycle overdue phase=deletion_flow",
        user.email,
        "startedAt=" + overdueStartedAtISO
      );

      if (!user.isDisabled) {
        await User.disable(user);
        disabled += 1;
        // This user skipped disabled_grace (e.g. the job failed to reach
        // them during that window), so this is the first time they're
        // actually disabled - tell them here instead.
        email.OVERDUE_CLOSURE(user.uid);
      }

      return await queueRemoval(user, overdue);
    }

    var details = subscriptionLifecycle.cancellationDetails(user);

    if (!details.cancelled || !details.periodEnded) return;

    if (!user.isDisabled) {
      await User.disable(user);
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
    }

    await queueRemoval(user, overdue);
  }

  // Never rejects, so the iteration over users carries on whatever happens
  // to one of them
  async function handleUser(user) {
    var overdue;

    try {
      overdue = await removal.overdueFor(user);
    } catch (err) {
      // A Stripe hiccup for one unpaid user shouldn't stop the whole job
      // (or the removal email); they'll be picked up on the next run.
      console.log(
        clfdate(),
        "Subscription lifecycle could not check overdue status",
        user.email,
        err
      );
      return;
    }

    // Likewise for a failed disable or removal: log it and move on so
    // the rest of the users (and the removal email) still get processed.
    try {
      await processUser(user, overdue);
    } catch (processErr) {
      console.log(
        clfdate(),
        "Subscription lifecycle could not process user",
        user.email,
        user.uid,
        processErr
      );
    }
  }

  try {
    await promisify(eachUser)(function (user, next) {
      handleUser(user).then(function () {
        next();
      });
    });
  } catch (err) {
    console.log(clfdate(), "Subscription lifecycle job failed", err);
    throw err;
  }

  console.log(
    clfdate(),
    "Subscription lifecycle job complete",
    "disabled=" + disabled,
    "deleted=" + deleted
  );

  if (!usersToRemove.length) return;

  try {
    await promisify(email.USERS_DUE_FOR_REMOVAL)("", {
      users: usersToRemove,
      count: usersToRemove.length,
      singular: usersToRemove.length === 1,
    });
  } catch (emailErr) {
    // Log and swallow: the lifecycle work already succeeded by this
    // point, so a transient email failure shouldn't fail the job.
    console.log(
      clfdate(),
      "Subscription lifecycle job failed to send users-to-remove summary",
      emailErr
    );
  }
};
