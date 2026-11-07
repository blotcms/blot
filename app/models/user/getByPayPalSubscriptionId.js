var ensure = require("helper/ensure");
var client = require("models/client");
var key = require("./key");
var getById = require("./getById");

module.exports = async function getByPayPalSubscriptionId(subscriptionId) {
  ensure(subscriptionId, "string");

  var uid = await client.get(key.paypal(subscriptionId));

  if (!uid) return null;

  return await getById(uid);
};
