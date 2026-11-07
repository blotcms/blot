var ensure = require("helper/ensure");
var promiseOnly = require("helper/promiseOnly");
var client = require("models/client");
var key = require("./key");
var getById = require("./getById");

module.exports = promiseOnly(
  async function getByPayPalSubscriptionId(subscriptionId) {
    ensure(subscriptionId, "string");

    var uid = await client.get(key.paypal(subscriptionId));

    if (!uid) return null;

    return await getById(uid);
  }
);
