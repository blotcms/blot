var ensure = require("helper/ensure");
var validate = require("./validate");
var client = require("models/client");
var updateBillingEmail = require("./updateBillingEmail");
var key = require("./key");

// Compare the exact value we validated, then update the document and its
// indexes together. Unlike WATCH on the shared connection this is safe when
// several requests (or application processes) update users concurrently.
var commit = `
  if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
  for i = 2, 4 do
    if KEYS[i] ~= '' then
      local owner = redis.call('GET', KEYS[i])
      if owner and owner ~= ARGV[3] then return -i end
    end
  end
  for i = 5, 7 do
    if KEYS[i] ~= '' and KEYS[i] ~= KEYS[i - 3] then
      if redis.call('GET', KEYS[i]) == ARGV[3] then
        redis.call('DEL', KEYS[i])
      end
    end
  end
  redis.call('SET', KEYS[1], ARGV[2])
  for i = 2, 4 do
    if KEYS[i] ~= '' then redis.call('SET', KEYS[i], ARGV[3]) end
  end
  return 1
`;

function indexes(user) {
  return [
    user.email ? key.email(user.email) : "",
    user.subscription && user.subscription.customer
      ? key.customer(user.subscription.customer) : "",
    user.paypal && user.paypal.id ? key.paypal(user.paypal.id) : "",
  ];
}

module.exports = function save(uid, updates, callback) {
  ensure(uid, "string").and(updates, "object").and(callback, "function");

  (async function () {
    for (var attempt = 0; attempt < 20; attempt++) {
      var previous = await client.get(key.user(uid));
      if (!previous) throw new Error("No user");

      var user;
      try {
        user = JSON.parse(previous);
        ensure(user, "object");
      } catch (err) {
        throw new Error("BADJSON");
      }
      var former = JSON.parse(previous);
      if (typeof user.created === "undefined") user.created = 0;
      if (typeof user.welcomeEmailSent === "undefined")
        user.welcomeEmailSent = true;

      var result = await new Promise(function (resolve, reject) {
        validate(user, updates, function (err, validated, changes) {
          if (err) return reject(err);
          resolve({ user: validated, changes: changes });
        });
      });

      var status = await client.eval(commit, {
        keys: [key.user(uid)].concat(indexes(result.user), indexes(former)),
        arguments: [previous, JSON.stringify(result.user), uid],
      });

      if (status === 0) continue;
      if (status < 0) {
        var conflict = new Error(status === -2
          ? "This email is in use." : "This subscription is in use.");
        conflict.code = "EEXISTS";
        throw conflict;
      }

      // Only dispatch external side effects after a successful commit, never
      // from an abandoned validation attempt.
      if (former.email && former.email !== result.user.email) {
        updateBillingEmail(result.user, function (err) {
          if (err) console.log("Error updating email for customer on Stripe:", err);
        });
      }
      return result.changes;
    }

    var busy = new Error("User changed too frequently; please retry");
    busy.code = "EAGAIN";
    throw busy;
  })().then(function (changes) {
    callback(null, changes);
  }, callback);
};
