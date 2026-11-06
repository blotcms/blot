var auth = require("http-auth");
var Blog = require("models/blog");
var User = require("models/user");
var database = require("./database");
var clfdate = require("helper/clfdate");

module.exports = auth.connect(
  // Beware that req as fourth argument might not be reliable:
  // https://github.com/http-auth/http-auth/pull/67#issuecomment-244306701
  auth.basic({ realm: "Git" }, function (email, token, callback, req) {
    console.log(clfdate() + " Git: authenticate: checking user and token");

    User.getByEmail(email, function (err, user) {
      // There is no user with this email address
      if (err || !user) {
        console.log(
          clfdate() + " Git: authenticate: no user with email",
          email
        );
        return callback(false);
      }

      console.log(clfdate() + " Git: authenticate: checking token");

      database.checkToken(user.uid, token, function (err, valid) {
        // The token is bad
        if (err || !valid) {
          console.log(
            clfdate() + " Git: authenticate: bad token for user",
            user.uid
          );
          return callback(false);
        }

        // User is attempting to push or pull another user's repo
        Blog.get({ handle: req.gitHandle }, function (err, blog) {
          // There is no blog with this handle
          if (err || !blog || blog.handle !== req.gitHandle) {
            console.log(
              clfdate() + " Git: authenticate: no blog with handle",
              req.gitHandle
            );
            return callback(false);
          }

          // The account associated with this email does not have permission
          // to modify this blog.
          if (blog.owner !== user.uid) {
            console.log(
              clfdate() + " Git: authenticate: user",
              user.uid,
              "does not own blog",
              blog.id
            );
            return callback(false);
          }

          req.blog = blog;

          console.log(
            clfdate() + " Git: authenticate: user",
            user.uid,
            "has permission to modify blog",
            blog.id
          );
          callback(true);
        });
      });
    });
  })
);
