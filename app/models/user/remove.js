var getById = require("./getById");
var ensure = require("helper/ensure");
var client = require("models/client");
var key = require("./key");

module.exports = async function remove(uid) {
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

  // Everything else under the user's prefix, such as the git client's token
  // and status
  for await (const found of client.scanIterator({
    MATCH: "user:" + uid + ":*",
    COUNT: 1000,
  })) {
    keys = keys.concat(found);
  }

  var multi = client.multi();

  multi.sRem(key.uids, uid);
  multi.del(keys);

  await multi.exec();
};
