const fs = require("fs-extra");
const config = require("config");
const ensure = require("helper/ensure");
const extend = require("helper/extend");
const tempDir = require("helper/tempDir")();
const Mustache = require("mustache");
const { marked } = require("marked");
const clfdate = require("helper/clfdate");

const mailgunClient = (() => {
  if (config && config.mailgun && config.mailgun.key && config.mailgun.domain) {
    const Mailgun = require("mailgun.js");
    const formData = require("form-data");
    const mailgun = new Mailgun(formData);

    return mailgun.client({
      username: (config.mailgun && config.mailgun.username) || "api",
      key: config.mailgun.key,
    });
  }

  return null;
})();

const hasMailgunClient =
  mailgunClient &&
  mailgunClient.messages &&
  typeof mailgunClient.messages.create === "function";

var adminDir = __dirname + "/admin/";
var userDir = __dirname + "/user/";

var ADMIN = config.admin.email || "admin@" + config.host;
var FROM = config.mailgun.from || "admin@" + config.host;

// This module checks /user and /admin
// for each message + .txt in the list
// below. If it finds a file in /admin
// it will send it to me. If it finds
// a file in /user, it will send it
// to the user whose uid was passed.
var MESSAGES = [
  "ALREADY_CANCELLED",
  "BAD_REQUEST",
  "BILLING_INTERVAL",
  "CANCELLED",
  "CANCELLED_FIRST_PERIOD",
  "CLOSED",
  "DELETED_FIRST_PERIOD",
  "CREATED_BLOG",
  "DAILY_UPDATE",
  "DELETED",
  "DISABLED",
  "DROPBOX_SYNC_ISSUE",
  "GIT_STORE_ALERT",
  "GIT_SWEEP_ALERT",
  "GOOGLE_DRIVE_SERVICE_ACCOUNT_LOW",
  "GOOGLE_DRIVE_SYNC_ISSUE",
  "ICLOUD_SYNC_ISSUE",
  "ICLOUD_APPROACHING_DISK_LIMIT",
  "ICLOUD_DISK_LIMIT",
  "ICLOUD_APPROACHING_QUOTA_LIMIT",
  "ICLOUD_QUOTA_LIMIT",
  "ICLOUD_RESYNC_ISSUE",
  "ICLOUD_SERVER_STARTED",
  "ICLOUD_SERVER_DOWN",
  "ICLOUD_SERVER_RECOVERED",
  "ICLOUD_SERVER_PANIC",
  "LONG_DELAY",
  "LONG_SYNC",
  "NETWORK_ERROR",
  "NEWSLETTER_SUBSCRIPTION_CONFIRMED",
  "NEWSLETTER_SUBSCRIPTION_CONFIRMATION",
  "NEWSLETTER_CANCELLATION_CONFIRMED",
  "NEWSLETTER_CANCELLATION_CONFIRMATION",
  "NO_SPACE",
  "OVERDUE",
  "OVERDUE_CLOSURE",
  "QUESTION",
  "QUESTION_PUBLISHED",
  "QUESTION_REPLY_PUBLISHED",
  "RATE_LIMIT",
  "RESTART",
  "RECOVERED",
  "REDIS_HOST_ALERT",
  "SANDBOX_ALERT",
  "RESYNC_FOUND_CHANGES",
  "REVOKED",
  "SET_PASSWORD",
  "SERVER_START",
  "SUBSCRIPTION_DECREASE",
  "SSL_CERTIFICATE_ISSUES",
  "SUSPECTED_FRAUD",
  "SYNC_DOWN",
  "SYNC_EXCEPTION",
  "SYNC_REPORT",
  "UPCOMING_RENEWAL",
  "UPCOMING_MONTHLY_FIRST_RENEWAL",
  "UPCOMING_EXPIRY",
  "UPDATE_BILLING",
  "USERS_DUE_FOR_REMOVAL",
  "WARNING_LOW_DISK_SPACE",
  "WELCOME",
  "WORKER_ERROR",
  "ZOMBIE_PROCESS",
];

var globals = {
  site: "https://" + config.host,
};

var EMAIL_MODEL = {
  to: "string",
  from: "string",
  subject: "string",
  html: "string",
  "h:Reply-To": "string",
};

async function loadUser(uid) {
  if (!uid) return {};

  const User = require("models/user");

  const user = await User.getById(uid);

  if (!user) throw new Error("No user with uid " + uid);

  return User.extend(user);
}

// The functions this builds are used fire-and-forget all over the app, with
// or without a callback. They never throw and never return a promise: the
// outcome goes to the callback (a no-op by default), so a failed send can't
// become an unhandled rejection.
function init(method) {
  ensure(method, "string");
  return function build(uid = "", locals = {}, callback = function () {}) {
    deliver.call(this, method, uid, locals).then(function (results) {
      callback(null, results);
    }, callback);
  };
}

async function deliver(method, uid, locals) {
  const user = await loadUser(uid);

  extend(locals).and(globals).and(user);

  const adminMessage = adminDir + method + ".txt";
  const userMessage = userDir + method + ".txt";

  let emails = [];

  if (fs.existsSync(adminMessage)) {
    emails.push(send.call(this, locals, adminMessage, ADMIN));
  }

  if (fs.existsSync(userMessage)) {
    emails.push(send.call(this, locals, userMessage, locals.email));
  }

  return await Promise.all(emails);
}

async function send(locals, messageFile, to) {
  ensure(locals, "object").and(messageFile, "string").and(to, "string");

  const text = await fs.readFile(messageFile, "utf-8");

  var lines = text.split("\n");
  var subject = Mustache.render(lines[0] || "", locals);
  var message = lines.slice(2).join("\n") || "";

  var html = marked.parse(Mustache.render(message, locals));

  var email = {
    html: html,
    subject: subject,
    from: locals.from || FROM,
    to: to,
    "h:Reply-To": locals.replyTo || locals.from || FROM,
  };

  ensure(email, EMAIL_MODEL);

  if (config.environment === "development" && process.env.EMAIL !== "true") {
    var previewPath = tempDir + Date.now() + ".html";
    fs.outputFileSync(previewPath, email.html, "utf-8");
    console.log(clfdate(), "Email: unsent in development environment:", {
      ...email,
      preview: previewPath,
    });
    return;
  }

  if (!hasMailgunClient) {
    console.log(
      clfdate(),
      "Email: Mailgun client unavailable, skipping send for",
      email.to,
      '"' + email.subject + '"'
    );
    return;
  }

  try {
    const body = await mailgunClient.messages.create(
      config.mailgun.domain,
      email
    );

    console.log(
      clfdate(),
      "Email: sent to",
      email.to,
      '"' + email.subject + '"',
      "(" + (body && body.id) + ")"
    );
  } catch (err) {
    console.log(
      clfdate(),
      "Email: error: Mailgun failed to send transactional email:",
      err
    );
    throw err;
  }
}

var exports = {};

for (var i in MESSAGES) {
  var method = MESSAGES[i];
  exports[method] = init(method);
}

const promiseOnly = require("helper/promiseOnly");

exports.send = promiseOnly(send);

module.exports = exports;
