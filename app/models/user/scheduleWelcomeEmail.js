const ensure = require("helper/ensure");
const debug = require("debug")("blot:user:scheduleWelcomeEmail");
const alarm = require("helper/alarm");
const lock = require("helper/lock");
const client = require("models/client");

const email = require("helper/email");
const getById = require("./getById");
const set = require("./set");
const getAllIds = require("./getAllIds");

const WELCOME_EMAIL_DELAY_MS = 2 * 60 * 60 * 1000; // 2 hours

// A short claim held while a send is in progress, longer than any send. It is
// not the record of the send (welcomeEmailSent is): if the sender dies the
// claim just expires and a retry sends.
const SENDING_CLAIM_TTL_MS = 10 * 60 * 1000;

function sendingKey(uid) {
  return "welcome-email:sending:" + uid;
}

function getCreatedDate(user) {
  if (!user) return new Date();

  if (typeof user.created === "number") {
    return new Date(user.created);
  }

  if (typeof user.created === "string") {
    const parsed = Date.parse(user.created);

    if (!Number.isNaN(parsed)) return new Date(parsed);
  }

  return new Date();
}

function getUser(uid) {
  return new Promise(function (resolve, reject) {
    getById(uid, function (err, user) {
      if (err) return reject(err);
      resolve(user);
    });
  });
}

function sendWelcome(uid) {
  return new Promise(function (resolve, reject) {
    email.WELCOME(uid, {}, function (err) {
      if (err) return reject(err);
      resolve();
    });
  });
}

function setUser(uid, updates) {
  return new Promise(function (resolve, reject) {
    set(uid, updates, function (err) {
      if (err) return reject(err);
      resolve();
    });
  });
}

// Runs in whichever process claims the alarm, and again if the alarm is
// retried, so it must be safe to run twice (even at the same time). The
// durable record is user.welcomeEmailSent; a short Redis claim lets only one
// run send at a time. A run that loses the claim throws, so its alarm is not
// completed and is retried after its lease: by then the sender has either
// recorded the send (retry returns) or died and its claim expired (retry
// sends). If the send fails the claim is removed so the retry can send.
async function handler(uid) {
  const user = await getUser(uid);

  if (!user || user.welcomeEmailSent) return;

  const won = await lock.once(sendingKey(uid), SENDING_CLAIM_TTL_MS);

  if (!won) {
    throw new Error("welcome email for " + uid + " is being sent elsewhere");
  }

  try {
    await sendWelcome(uid);
  } catch (err) {
    debug(uid, "Failed to send welcome email", err);
    await client.del(sendingKey(uid));
    throw err;
  }

  await setUser(uid, { welcomeEmailSent: true });
  await client.del(sendingKey(uid));
  debug(uid, "Welcome email sent and recorded");
}

const alarms = alarm("welcome-email", handler);

function scheduleWelcomeEmail(uid, callback = function () {}) {
  try {
    ensure(uid, "string").and(callback, "function");
  } catch (err) {
    return callback(err);
  }

  getById(uid, function (err, user) {
    if (err) return callback(err);

    if (!user) return callback(new Error("No user"));

    if (user.welcomeEmailSent) {
      debug(uid, "Welcome email already sent, cancelling alarm");
      return alarms.cancel(uid).then(function () {
        callback();
      }, callback);
    }

    // A time in the past is claimed on the next poll
    const scheduledTime = new Date(
      getCreatedDate(user).getTime() + WELCOME_EMAIL_DELAY_MS
    );

    alarms.set(uid, scheduledTime).then(function () {
      debug(uid, "Scheduled welcome email for", scheduledTime);
      callback();
    }, callback);
  });
}

// Re-arms the alarm for recent users who haven't been sent the email and have
// no alarm (e.g. the sign-up route's scheduling failed after the user was
// committed). Resolves to the number of alarms set.
async function reconcile({ days = 7 } = {}) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const uids = await new Promise(function (resolve, reject) {
    getAllIds(function (err, uids) {
      if (err) return reject(err);
      resolve(uids);
    });
  });
  let scheduled = 0;

  for (const uid of uids) {
    try {
      const user = await getUser(uid);

      if (!user || user.welcomeEmailSent || !(user.created >= since)) continue;
      if ((await alarms.when(uid)) !== null) continue;

      await new Promise(function (resolve, reject) {
        scheduleWelcomeEmail(uid, function (err) {
          if (err) return reject(err);
          resolve();
        });
      });
      scheduled++;
    } catch (err) {
      console.error("Error reconciling welcome email alarm for", uid, err);
    }
  }

  return scheduled;
}

scheduleWelcomeEmail.alarm = alarms;
scheduleWelcomeEmail.handler = handler;
scheduleWelcomeEmail.reconcile = reconcile;
scheduleWelcomeEmail.sendingKey = sendingKey;
scheduleWelcomeEmail.SENDING_CLAIM_TTL_MS = SENDING_CLAIM_TTL_MS;
scheduleWelcomeEmail.WELCOME_EMAIL_DELAY_MS = WELCOME_EMAIL_DELAY_MS;

module.exports = scheduleWelcomeEmail;
