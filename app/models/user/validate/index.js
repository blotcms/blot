var ensure = require("helper/ensure");

var MODEL = require("../model");

var validators = {
  email: require("./email"),
};

// Calls back (err, user, changes), so it stays callback-shaped.
module.exports = function validate(user, updates, callback) {
  ensure(user, MODEL).and(updates, "object").and(callback, "function");

  var changes = [];

  try {
    ensure(updates, MODEL);
  } catch (err) {
    return callback(err);
  }

  // All the updates are validated at once, and the first error wins
  Promise.all(
    Object.keys(updates).map(async function (name) {
      var value = updates[name];

      ensure(value, MODEL[name]);

      if (!validators[name]) {
        user[name] = value;
        changes.push(name);
        return;
      }

      value = await validators[name](user, value);

      if (value && user[name] !== value) {
        user[name] = value;
        changes.push(name);
      }
    })
  ).then(function () {
    // Check user properties are correct type
    try {
      ensure(user, MODEL, true);
    } catch (err) {
      return callback(err);
    }

    return callback(null, user, changes);
  }, callback);
};
