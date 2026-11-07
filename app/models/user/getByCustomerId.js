var ensure = require("helper/ensure");
var promiseOnly = require("helper/promiseOnly");
var client = require("models/client");
var key = require("./key");
var getById = require("./getById");

module.exports = promiseOnly(async function getByCustomerId(customerId) {
  ensure(customerId, "string");

  var uid = await client.get(key.customer(customerId));

  if (!uid) return null;

  return await getById(uid);
});
