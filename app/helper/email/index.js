const fs = require("fs-extra");
const async = require("async");
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
      key: config.mailgun.key
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
  "GOOGLE_DRIVE_SERVICE_ACCOUNT_LOW",
  "ICLOUD_SYNC_ISSUE",
  "ICLOUD_APPROACHING_DISK_LIMIT",
  "ICLOUD_DISK_LIMIT",
  "ICLOUD_APPROACHING_QUOTA_LIMIT",
  "ICLOUD_QUOTA_LIMIT",
  "ICLOUD_RESYNC_REQUESTED",
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
  "OVERDUE_SUBSCRIPTION_DISABLED_GRACE",
  "QUESTION",
  "QUESTION_PUBLISHED",
  "QUESTION_REPLY_PUBLISHED",
  "RATE_LIMIT",
  "RESTART",
  "RECOVERED",
  "REVOKED",
  "SET_PASSWORD",
  "SERVER_START",
  "SUBSCRIPTION_DECREASE",
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
  "ZOMBIE_PROCESS"
];

var globals = {
  site: "https://" + config.host
};

var EMAIL_MODEL = {
  to: "string",
  from: "string",
  subject: "string",
  html: "string",
  "h:Reply-To": "string"
};

function loadUser (uid, callback) {
  if (!uid) return callback(null, {});

  const User = require("models/user");

  User.getById(uid, function (err, user) {
    if (err || !user) {
      return callback(err || new Error("No user with uid " + uid));
    }

    user = User.extend(user);

    callback(null, user);
  });
}

function init (method) {
  ensure(method, "string");
  return function build (uid = "", locals = {}, callback = function () {}) {
    loadUser(uid, function (err, user) {
      if (err) return callback(err);

      extend(locals).and(globals).and(user);

      const adminMessage = adminDir + method + ".txt";
      const userMessage = userDir + method + ".txt";

      let emails = [];

      if (fs.existsSync(adminMessage)) {
        emails.push(send.bind(this, locals, adminMessage, ADMIN));
      }

      if (fs.existsSync(userMessage)) {
        emails.push(send.bind(this, locals, userMessage, locals.email));
      }

      async.parallel(emails, callback);
    });
  };
}

function send (locals, messageFile, to, callback) {
  ensure(locals, "object")
    .and(messageFile, "string")
    .and(to, "string")
    .and(callback, "function");

  fs.readFile(messageFile, "utf-8", function (err, text) {
    if (err) return callback(err);

    var lines = text.split("\n");
    var subject = Mustache.render(lines[0] || "", locals);
    var message = lines.slice(2).join("\n") || "";

    var html = marked.parse(Mustache.render(message, locals));

    var email = {
      html: html,
      subject: subject,
      from: locals.from || FROM,
      to: to,
      'h:Reply-To': locals.replyTo || locals.from || FROM
    };

    try {
      ensure(email, EMAIL_MODEL);
    } catch (e) {
      return callback(e);
    }

    if (config.environment === "development" && process.env.EMAIL !== "true") {
      var previewPath = tempDir + Date.now() + ".html";
      fs.outputFileSync(previewPath, email.html, "utf-8");
      console.log(clfdate(), "Email: unsent in development environment:", {
        ...email,
        preview: previewPath
      });
      return callback();
    }

    if (!hasMailgunClient) {
      console.log(
        clfdate(),
        "Email: Mailgun client unavailable, skipping send for",
        email.to,
        '"' + email.subject + '"'
      );
      return callback();
    }

    mailgunClient.messages
      .create(config.mailgun.domain, email)
      .then(function (body) {
        console.log(
          clfdate(),
          "Email: sent to",
          email.to,
          '"' + email.subject + '"',
          "(" + (body && body.id) + ")"
        );
        callback();
      })
      .catch(function (err) {
        console.log(
          clfdate(),
          "Email: error: Mailgun failed to send transactional email:",
          err
        );
        callback(err);
      });
  });
}

var exports = {};

for (var i in MESSAGES) {
  var method = MESSAGES[i];
  exports[method] = init(method);
}

exports.send = send;

module.exports = exports;
