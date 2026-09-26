const express = require("express");
const site = express.Router();
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const config = require("config");
const debug = require("debug")("blot:clients:onedrive:routes");

function safeEqual(a, b) {
  const expected = Buffer.from(String(a));
  const actual = Buffer.from(String(b));

  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Microsoft sends the user back to blot.im/clients/onedrive/authenticate
// after they accept or decline. This public route has no session, so we
// find the blog from cookies set by the dashboard's /redirect route and
// check the OAuth `state` against the cookie to make sure this login was
// started by this browser. We then hand the code to the dashboard route
// (which has the session and blog) to exchange it for tokens.
site.get("/authenticate", cookieParser(), function (req, res, next) {
  const handle = req.cookies.onedriveBlog;
  const state = req.cookies.onedriveState;

  if (!handle || !state) {
    return next(new Error("No blog to authenticate"));
  }

  res.clearCookie("onedriveBlog");
  res.clearCookie("onedriveState");

  if (!safeEqual(req.query.state || "", state)) {
    return next(new Error("Invalid OneDrive authentication state"));
  }

  const clientPage = "/sites/" + encodeURIComponent(handle) + "/client";

  // The user declined, or Microsoft reported an error
  if (req.query.error) {
    debug("Authorization failed:", req.query.error);
    return res.redirect(clientPage);
  }

  if (!req.query.code) {
    return next(new Error("No authorization code from OneDrive"));
  }

  // Same-origin path with all user input percent-encoded.
  res.redirect(
    clientPage +
      "/onedrive/authenticate?code=" +
      encodeURIComponent(req.query.code)
  );
});

// Microsoft Graph POSTs change notifications here. Two cases:
//
// 1. Subscription validation: when a subscription is created, Graph
//    POSTs with ?validationToken=... and expects that token echoed back
//    as text/plain with a 200 within 10 seconds.
// 2. Notifications: a JSON body { value: [{ subscriptionId, clientState,
//    resource, ... }] }. Each item carries the clientState we set when
//    creating the subscription, which must match our webhook secret.
//    Respond 202 quickly - Graph retries slow or failed deliveries.
//
// Handling the notifications themselves (finding the blog for the
// subscription, running the delta query) is added once the Redis schema
// exists. See PLAN.md, "Webhook listening".
site.post("/webhook", function (req, res) {
  if (config.maintenance) return res.sendStatus(503);

  const secret = config.onedrive.webhook_secret;

  if (!secret) return res.sendStatus(503);

  const validationToken = req.query.validationToken;

  if (typeof validationToken === "string") {
    debug("Answered subscription validation handshake");
    return res.status(200).type("text/plain").send(validationToken);
  }

  let data = "";

  req.setEncoding("utf8");

  req.on("data", function (chunk) {
    data += chunk;
  });

  req.on("end", function () {
    let notifications;

    try {
      notifications = JSON.parse(data).value;
    } catch (e) {
      return res.sendStatus(400);
    }

    if (
      !Array.isArray(notifications) ||
      !notifications.every(function (n) {
        return n && safeEqual(n.clientState || "", secret);
      })
    ) {
      debug("Rejected webhook with invalid clientState");
      return res.sendStatus(403);
    }

    debug("Received", notifications.length, "notification(s)");

    res.sendStatus(202);
  });
});

module.exports = site;
