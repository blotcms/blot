var ensure = require("helper/ensure");
var promiseOnly = require("helper/promiseOnly");

var MODEL = require("../model");

var validators = {
  email: require("./email"),
};

// async validate(user, updates) merges the updates into user and resolves
// { user, changes }. It rejects with the first validation error.
module.exports = promiseOnly(async function validate(user, updates) {
  ensure(user, MODEL).and(updates, "object");

  var changes = [];

  ensure(updates, MODEL);

  // All the updates are validated at once, and the first error wins
  await Promise.all(
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
  );

  // Check user properties are correct type
  ensure(user, MODEL, true);

  return { user: user, changes: changes };
});
