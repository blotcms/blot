var ensure = require("helper/ensure");
var client = require("models/client");
var key = require("./key");
var getById = require("./getById");

module.exports = async function getBy(email) {
  ensure(email, "string");

  email = email.trim().toLowerCase();

  var uid = await client.get(key.email(email));

  if (!uid) return null;

  return await getById(uid);
};
