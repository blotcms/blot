var ensure = require("helper/ensure");
var withCallback = require("helper/withCallback");
var client = require("models/client");
var key = require("./key");
var getById = require("./getById");

module.exports = withCallback(async function getByCustomerId(customerId) {
  ensure(customerId, "string");

  var uid = await client.get(key.customer(customerId));

  if (!uid) return null;

  return await getById(uid);
});
