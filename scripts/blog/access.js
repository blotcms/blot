var Blog = require("models/blog");
var User = require("models/user");
var format = require("url").format;
var config = require("../../config");

if (require.main === module) {
  require("../get/blog")(process.argv[2], function (err, user, blog) {
    main((blog && blog.handle) || process.argv[2], function (err, url) {
      if (err) throw err;
      console.log(url);
      process.exit();
    });
  });
}

function main(handle, callback) {
  User.getById(handle, function (err, userID) {
    if (err) return callback(err);

    User.getByEmail(handle, function (err, userEmail) {
      if (err) return callback(err);

      Blog.get({ handle: handle }, function (err, blog) {
        if (err) return callback(err);

        var uid =
          (userEmail && userEmail.uid) ||
          (userID && userID.uid) ||
          (blog && blog.owner);

        if (!uid)
          return callback(new Error("No user with identifier " + handle));

        User.generateAccessToken({ uid }, function (err, token) {
          if (err) throw err;

          // The full one-time log-in link to be sent to the user
          var url = format({
            protocol: "https",
            host: config.host,
            pathname: "/sites/log-in",
            query: {
              token: token,
            },
          });

          callback(null, url);
        });
      });
    });
  });
}

module.exports = main;
