const express = require("express");
const paypal = new express.Router();
const parser = require("body-parser");
const User = require("models/user");
const config = require("config");
const clfdate = require("helper/clfdate");
const subscriptionLifecycle = require("models/user/subscriptionLifecycle");

const SUBSCRIPTION_EVENTS = [
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.EXPIRED",
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "BILLING.SUBSCRIPTION.RE-ACTIVATED",
  "BILLING.SUBSCRIPTION.UPDATED",
  "BILLING.SUBSCRIPTION.CREATED"
];

const prefix = () => `${clfdate()} PayPal Webhook:`;

async function fetchJSON(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`PayPal returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// Verify an incoming PayPal webhook via PayPal's verify-webhook-signature API.
// Returns true when verification succeeds - or when no webhook id is configured,
// in which case verification is skipped and the previous behaviour preserved,
// so this is safe to deploy before BLOT_PAYPAL_WEBHOOK_ID is set.
const verifyPayPalWebhook = async req => {
  const webhookId = config.paypal.webhook_id;

  if (!webhookId) {
    console.warn(
      prefix(),
      "signature NOT verified - set BLOT_PAYPAL_WEBHOOK_ID to enable"
    );
    return true;
  }

  const json = await fetchJSON(
    `${config.paypal.api_base}/v1/notifications/verify-webhook-signature`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${Buffer.from(
          `${config.paypal.client_id}:${config.paypal.secret}`
        ).toString("base64")}`
      },
      body: JSON.stringify({
        auth_algo: req.headers["paypal-auth-algo"],
        cert_url: req.headers["paypal-cert-url"],
        transmission_id: req.headers["paypal-transmission-id"],
        transmission_sig: req.headers["paypal-transmission-sig"],
        transmission_time: req.headers["paypal-transmission-time"],
        webhook_id: webhookId,
        webhook_event: req.body
      })
    }
  );

  return json.verification_status === "SUCCESS";
};

paypal.post("/", parser.json(), async (req, res) => {
  // Verify the webhook signature when a webhook id is configured (see above).
  try {
    const verified = await verifyPayPalWebhook(req);
    if (!verified) {
      console.log(prefix(), "signature verification failed");
      return res.status(400).send("Invalid signature");
    }
  } catch (err) {
    console.log(prefix(), "signature verification error", err);
    return res.sendStatus(503);
  }

  const eventType = req.body && req.body.event_type;
  // resource.id used to be read unconditionally, which threw - and crashed the
  // process via an unhandled rejection - on any request without a resource.
  const subscriptionID =
    req.body && req.body.resource && req.body.resource.id;

  // if the webhook is for a subscription-related event, update the subscription
  if (SUBSCRIPTION_EVENTS.includes(eventType)) {
    if (typeof subscriptionID !== "string" || !subscriptionID) {
      console.log(prefix(), "missing resource.id for", eventType);
      return res.sendStatus(400);
    }

    console.log(prefix(), eventType, subscriptionID);

    try {
      await updateSubscription(subscriptionID);
      console.log(prefix(), "Updated subscription successfully");
    } catch (err) {
      console.log(prefix(), err);
      return res.sendStatus(503);
    }
  } else {
    console.log(prefix(), "Unhandled event", req.body);
  }

  res.status(200).send("OK");
});

const updateSubscription = async subscriptionID => {
  const user = await new Promise((resolve, reject) => {
    User.getByPayPalSubscriptionId(subscriptionID, (err, user) => {
      if (err) return reject(err);
      resolve(user);
    });
  });
  if (!user) {
    throw new Error("No user associated with subscription ID " + subscriptionID);
  }

  const paypal = await fetchJSON(
    `${config.paypal.api_base}/v1/billing/subscriptions/${encodeURIComponent(subscriptionID)}`,
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

  if (!paypal || paypal.id !== subscriptionID || typeof paypal.status !== "string") {
    throw new Error("Invalid PayPal subscription response");
  }
  return new Promise((resolve, reject) => {
    const updates = { paypal };
    const done = err => err ? reject(err) : resolve();
    const shouldDisable = subscriptionLifecycle.shouldDisableFromPaypalSubscription(paypal);
    // Preserve deliberate per-blog availability when the account is unchanged.
    // The model saves the account flag last to keep failures retryable.
    const shouldEnable = paypal.status === "ACTIVE" && user.isDisabled;

    if (shouldDisable && !user.isDisabled) return User.disable(user, updates, done);
    if (shouldEnable) return User.enable(user, updates, done);
    User.set(user.uid, updates, done);
  });
};

paypal.updateSubscription = updateSubscription;

module.exports = paypal;
