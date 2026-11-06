var ensure = require("helper/ensure");
var withCallback = require("helper/withCallback");
var client = require("models/client");
var key = require("./key");
var getById = require("./getById");

module.exports = withCallback(
  async function getByPayPalSubscriptionId(subscriptionId) {
    ensure(subscriptionId, "string");

    var uid = await client.get(key.paypal(subscriptionId));

    if (!uid) return null;

    return await getById(uid);
  }
);
