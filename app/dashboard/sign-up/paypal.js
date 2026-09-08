const config = require("config");
const fetch = require("node-fetch");
const User = require("models/user");
const express = require("express");
const paypal = new express.Router();

paypal.get("/", async (req, res, next) => {
  const { subscriptionID } = req.query;

  if (!subscriptionID) {
    return next(new Error("No subscription from PayPal"));
  }

  User.getByPayPalSubscriptionId(subscriptionID, async (err, user) => {
    if (err) return next(err);

    if (user && user.uid) return next(new Error("You already have an account"));

    const response = await fetch(
      `${config.paypal.api_base}/v1/billing/subscriptions/${subscriptionID}`,
      {
        headers: {
          "Content-Type": "application/json",
          "Accept-Language": "en_US",
          "Authorization": `Basic ${Buffer.from(
            `${config.paypal.client_id}:${config.paypal.secret}`
          ).toString("base64")}`
        }
      }
    );

    if (!response.ok) {
      return next(new Error("Could not verify subscription with PayPal"));
    }

    const json = await response.json();

    // Only accept an active subscription on a plan Blot actually sells - a
    // cancelled, suspended or legacy-plan subscription id must not create an
    // account.
    const configuredPlans = Object.values(config.paypal.plans || {}).filter(
      Boolean
    );
    if (
      !["ACTIVE", "APPROVED"].includes(json.status) ||
      (configuredPlans.length && !configuredPlans.includes(json.plan_id))
    ) {
      return next(new Error("Subscription is not active on a valid plan"));
    }

    if (!json.subscriber || !json.subscriber.email_address) {
      return next(new Error("No subscriber email from PayPal"));
    }

    req.session.paypal = json;
    req.session.email = json.subscriber.email_address;

    res.redirect("/sign-up/create-account");
  });
});

module.exports = paypal;
