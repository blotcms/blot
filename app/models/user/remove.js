var getById = require("./getById");
var ensure = require("helper/ensure");
var promiseOnly = require("helper/promiseOnly");
var client = require("models/client");
var key = require("./key");

module.exports = promiseOnly(async function remove(uid) {
  ensure(uid, "string");

  var user = await getById(uid);

  if (!user) throw new Error("No user");

  var keys = [
    key.user(uid),
    key.email(user.email),
    "sync:lease:" + uid,
    "sync:again:" + uid,
  ];

  if (user.subscription && user.subscription.customer) {
    keys.push(key.customer(user.subscription.customer));
  }

  if (user.paypal && user.paypal.id) {
    keys.push(key.paypal(user.paypal.id));
  }

  var multi = client.multi();

  multi.sRem(key.uids, uid);
  multi.del(keys);

  await multi.exec();
});
