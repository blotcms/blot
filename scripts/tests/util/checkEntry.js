var assert = require("assert");
var colors = require("colors");
var type = require("helper/type");
var withCallback = require("helper/withCallback");

function pad(len) {
  var str = "";
  while (str.length < len) str += " ";
  return str;
}

// Check if an entry with the passed properties exists in DB
module.exports = function CheckEntry(blogID) {
  return function (entry, callback) {
    // A failed read is the same as no entry (as before)
    var get = require("models/entry").get;
    withCallback(get)(blogID, entry.path, function (err, result) {
      if (!result && entry.ignored === true) {
        return callback(null, result);
      }
      if (!result) {
        return callback(new Error("No entry exists with path: " + entry.path));
      }

      var message = ["checking entry " + entry.path];

      for (var i in entry) {
        try {
          if (type(entry[i], "function")) {
            assert.deepEqual(
              entry[i](result[i]),
              true,
              i +
                colors.dim(" [failed check] ") +
                colors.dim("\n" + pad(i.length + 1) + "[returned] ") +
                result[i]
            );
          } else {
            assert.deepEqual(
              entry[i],
              result[i],
              i +
                colors.dim(" [expected] ") +
                entry[i] +
                colors.dim("\n" + pad(i.length + 1) + "[returned] ") +
                result[i]
            );
          }
        } catch (e) {
          message.push(e.message);
        }
      }

      if (message.length > 1) {
        return callback(new Error(message.join("\n")));
      } else {
        return callback(null, result);
      }
    });
  };
};
