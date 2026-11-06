var _ = require("lodash");
var MODEL = require("../scheme").TYPE;
var type = require("helper/type");
var ensure = require("helper/ensure");
var validator = {
  domain: require("./domain"),
  handle: require("./handle"),
  plugins: require("./plugins"),
  timeZone: require("./timeZone"),
  title: require("./title"),
};

// validator models should not modifiy the state of
// the database. they recieve a piece of information
// and return an error with explanation OR the piece
// of valid data.

// Export a function which provides async access
// to all the async modules. this requires user
// each time and is bad in that respect
// Resolves to the valid updates. Rejects with an object of errors keyed by
// field, or with the error that stopped validation.
module.exports = async function validate(blogID, updates) {
  ensure(blogID, "string").and(updates, MODEL);

  var validUpdates = {},
    errors = {},
    pending = [];

  for (var i in updates)
    if (type(validator[i]) === "function") {
      pending.push(i);
    } else {
      validUpdates[i] = updates[i];
    }

  // The validators all start together and finish in any order
  var results = await Promise.all(
    pending.map(function (key) {
      return validator[key](blogID, updates[key]).then(
        function (validUpdate) {
          return { key: key, validUpdate: validUpdate };
        },
        function (error) {
          return { key: key, error: error };
        }
      );
    })
  );

  results.forEach(function (result) {
    if (result.error) errors[result.key] = result.error;
    // validUpdate might be falsy (empty string, FALSE)
    if (result.validUpdate !== undefined)
      validUpdates[result.key] = result.validUpdate;
  });

  if (!_.isEmpty(errors)) throw errors;

  return validUpdates;
};
