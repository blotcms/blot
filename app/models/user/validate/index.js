var ensure = require("helper/ensure");
var async = require("async");

var MODEL = require("../model");

var validators = {
  email: require("./email"),
};

module.exports = function validate(user, updates, callback) {
  ensure(user, MODEL).and(updates, "object").and(callback, "function");

  var changes = [];

  try {
    ensure(updates, MODEL);
  } catch (err) {
    return callback(err);
  }

  async.eachOf(
    updates,
    function (value, name, next) {
      try {
        ensure(value, MODEL[name]);
      } catch (e) {
        return next(e);
      }

      if (!validators[name]) {
        user[name] = value;
        changes.push(name);
        return next();
      }

      validators[name](user, value, function (err, value) {
        if (err) return next(err);

        if (value && user[name] !== value) {
          user[name] = value;
          changes.push(name);
        }

        next();
      });
    },
    function (err) {
      if (err) return callback(err);

      // Added after users existed: records written before it get it here, on
      // their next save, rather than through a backfill
      if (user.paymentMethodsSyncedAt === undefined)
        user.paymentMethodsSyncedAt = 0;

      // Check user properties are correct type
      try {
        ensure(user, MODEL, true);
      } catch (err) {
        return callback(err);
      }

      return callback(null, user, changes);
    }
  );
};
