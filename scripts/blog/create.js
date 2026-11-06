var getConfirmation = require("../util/getConfirmation");
var Blog = require("models/blog");
var User = require("models/user");
var validate = require("models/blog/validate/handle");
var access = require("./access");

if (require.main === module) {
  main(process.argv[2], process.argv[3], function (err) {
    if (err) {
      console.error("Error:", err.message);
      return process.exit(1);
    }

    process.exit();
  });
}

function main(email, handle, callback) {
  if (!email) {
    return callback(
      new Error("Pass email of user to add new blog to as first argument")
    );
  }

  if (!handle) {
    return callback(new Error("Pass handle for new blog as second argument"));
  }

  validate("", handle, function (err, handle) {
    if (err) return callback(err);

    User.getByEmail(email, function (err, user) {
      if (err || !user) {
        return callback(
          new Error("No user with email " + email + " found in database")
        );
      }

      var message =
        "Email: " +
        user.email +
        "\nUser ID: " +
        user.uid +
        "\nHandle: " +
        handle +
        "\n\nCreate blog " +
        handle +
        "? (y/N)";

      getConfirmation(message, function (err, ok) {
        if (!ok) return callback(new Error("User was not created"));
        Blog.create(user.uid, { handle: handle }, function (err) {
          if (err) return callback(err);

          access(handle, function (err, url) {
            if (err) return callback(err);

            console.log("Added new blog", handle, "to", email, ":");
            console.log(url);
            callback(null);
          });
        });
      });
    });
  });
}

module.exports = main;
