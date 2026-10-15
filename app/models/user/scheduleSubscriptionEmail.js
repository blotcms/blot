var getById = require("./getById");
var getAllIds = require("./getAllIds");
var email = require("helper/email");
var lock = require("helper/lock");
var client = require("models/client");
var debug = require("debug")("blot:user:scheduleSubscriptionEmail");

// The number of days before a subscription is renewed or
// expired to send an email notification to the customer.
var DAYS_WARNING = 8;
var SECONDS_IN_DAY = 24 * 60 * 60;
var MS_IN_DAY = SECONDS_IN_DAY * 1000;
var MIN_MONTH_SECONDS = 27 * SECONDS_IN_DAY;
var MAX_MONTH_SECONDS = 32 * SECONDS_IN_DAY;

// The warning goes out at most DAYS_WARNING days before the period ends, so
// the marker outlives the period it guards by a wide margin
var SENT_MARKER_TTL_MS = 40 * MS_IN_DAY;

function roughlyOneMonth (seconds) {
  return seconds >= MIN_MONTH_SECONDS && seconds <= MAX_MONTH_SECONDS;
}

function isFirstMonthlyRenewal (subscription) {
  if (!subscription || !subscription.plan || subscription.plan.interval !== "month")
    return false;

  var created = subscription.created;
  var periodStart = subscription.current_period_start;
  var periodEnd = subscription.current_period_end;

  if (!created || !periodStart || !periodEnd) return false;

  var currentPeriodLength = periodEnd - periodStart;
  var timeFromStartToRenewal = periodEnd - created;

  return (
    roughlyOneMonth(currentPeriodLength) &&
    roughlyOneMonth(timeFromStartToRenewal)
  );
}

function sentKey (uid, periodEnd) {
  return "subscription-email:" + uid + ":" + periodEnd;
}

// Short claim held while a send is in progress (longer than any send)
var SENDING_CLAIM_TTL_MS = 10 * 60 * 1000;

function sendingKey (uid, periodEnd) {
  return "subscription-email:sending:" + uid + ":" + periodEnd;
}

// Which email, if any, is this user due right now? Pure: returns
// { name, periodEnd } where name is the helper/email method to call, or null.
// A user is due from the warning date (the period end minus DAYS_WARNING)
// until the period ends.
function decide (user, now) {
  if (now === undefined) now = Date.now();

  // This user does not have a subscription through Stripe
  if (!user || !user.subscription || !user.subscription.current_period_end)
    return null;

  var subscription = user.subscription;

  // For monthly subscriptions, we only send a warning for the first renewal.
  if (
    subscription.plan &&
    subscription.plan.interval === "month" &&
    !isFirstMonthlyRenewal(subscription)
  )
    return null;

  // Stripe uses a seconds timestamp vs. JavaScript's ms
  var periodEnd = subscription.current_period_end;
  var periodEndMs = periodEnd * 1000;
  var warningMs = periodEndMs - DAYS_WARNING * MS_IN_DAY;

  if (now < warningMs || now >= periodEndMs) return null;

  if (subscription.cancel_at_period_end)
    return { name: "UPCOMING_EXPIRY", periodEnd: periodEnd };

  if (subscription.status === "active") {
    if (isFirstMonthlyRenewal(subscription))
      return { name: "UPCOMING_MONTHLY_FIRST_RENEWAL", periodEnd: periodEnd };

    return { name: "UPCOMING_RENEWAL", periodEnd: periodEnd };
  }

  return null;
}

function getUser (uid) {
  return new Promise(function (resolve, reject) {
    getById(uid, function (err, user) {
      if (err) return reject(err);
      resolve(user);
    });
  });
}

function sendEmail (name, uid) {
  return new Promise(function (resolve, reject) {
    email[name](uid, {}, function (err) {
      if (err) return reject(err);
      resolve();
    });
  });
}

// Sends the user's warning email if they are due one and nobody has sent it
// for this billing period. Resolves to the email name sent, or null. The
// durable sent marker is set only after the send succeeds; a short sending
// claim keeps concurrent runs from sending at the same time. If the send
// fails the claim is removed so the next scan tries again. A crash between
// the send and the durable marker can resend after the claim expires, which
// is accepted: a duplicate warning beats a lost one.
async function sendForUser (uid, now) {
  var user = await getUser(uid);
  var decision = decide(user, now);

  if (!decision) return null;

  var durable = sentKey(uid, decision.periodEnd);
  var claim = sendingKey(uid, decision.periodEnd);

  if (await client.exists(durable)) return null;

  var won = await lock.once(claim, SENDING_CLAIM_TTL_MS);

  if (!won) return null;

  debug(uid, user.email, "Sending", decision.name);

  try {
    await sendEmail(decision.name, uid);
  } catch (err) {
    await client.del(claim);
    throw err;
  }

  await client.set(durable, "1", { PX: SENT_MARKER_TTL_MS });
  await client.del(claim);

  return decision.name;
}

// Run daily. Looks at every user, so it needs no per-process timers, picks up
// subscription changes made after sign-up, and is safe in any number of
// processes. An error for one user doesn't stop the rest. Resolves to the
// number of emails sent.
async function scan (now) {
  var uids = await new Promise(function (resolve, reject) {
    getAllIds(function (err, uids) {
      if (err) return reject(err);
      resolve(uids);
    });
  });
  var sent = 0;

  for (var i = 0; i < uids.length; i++) {
    try {
      if (await sendForUser(uids[i], now)) sent++;
    } catch (err) {
      console.error("Error sending subscription email for", uids[i], err);
    }
  }

  return sent;
}

module.exports = {
  decide: decide,
  sendForUser: sendForUser,
  scan: scan,
  sentKey: sentKey,
  sendingKey: sendingKey,
  SENDING_CLAIM_TTL_MS: SENDING_CLAIM_TTL_MS,
  SENT_MARKER_TTL_MS: SENT_MARKER_TTL_MS
};
