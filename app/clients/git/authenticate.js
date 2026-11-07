var auth = require("http-auth");
var Blog = require("models/blog");
var User = require("models/user");
var database = require("./database");
var clfdate = require("helper/clfdate");
var logContext = require("helper/logContext");

// Resolves to whether the user with this email address and token may push to
// or pull from the repository of the blog with the handle req.gitHandle. A
// failure to look anything up denies access.
async function check(email, token, req) {
  var user;

  try {
    user = await User.getByEmail(email);
  } catch (err) {
    user = null;
  }

  // There is no user with this email address
  if (!user) {
    console.log(clfdate() + " Git: authenticate: no user with email", email);
    return false;
  }

  console.log(clfdate() + " Git: authenticate: checking token");

  var valid;

  try {
    valid = await database.checkToken(user.uid, token);
  } catch (err) {
    valid = false;
  }

  // The token is bad
  if (!valid) {
    console.log(clfdate() + " Git: authenticate: bad token for user", user.uid);
    return false;
  }

  // User is attempting to push or pull another user's repo
  var blog;

  try {
    blog = await Blog.get({ handle: req.gitHandle });
  } catch (err) {
    blog = null;
  }

  // There is no blog with this handle
  if (!blog || blog.handle !== req.gitHandle) {
    console.log(
      clfdate() + " Git: authenticate: no blog with handle",
      req.gitHandle
    );
    return false;
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
    return false;
  }

  req.blog = blog;
  logContext.set({ blog: blog.id });

  console.log(
    clfdate() + " Git: authenticate: user",
    user.uid,
    "has permission to modify blog",
    blog.id
  );

  return true;
}

module.exports = auth.connect(
  // Beware that req as fourth argument might not be reliable:
  // https://github.com/http-auth/http-auth/pull/67#issuecomment-244306701
  auth.basic({ realm: "Git" }, function (email, token, callback, req) {
    console.log(clfdate() + " Git: authenticate: checking user and token");

    check(email, token, req).then(callback, function () {
      callback(false);
    });
  })
);
