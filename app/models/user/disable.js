var async = require("async");
var ensure = require("helper/ensure");
var setBlog = require("models/blog/set");
var set = require("./set");

module.exports = function disable(user, updates, callback) {
  if (typeof updates === "function") {
    callback = updates;
    updates = {};
  }

  updates = updates || {};
  callback = callback || function () {};

  ensure(user, "object");
  ensure(updates, "object");
  ensure(callback, "function");

  var blogs = Array.isArray(user.blogs) ? user.blogs.slice() : [];

  updates.isDisabled = true;

  // Keep the persisted account flag unchanged until every blog is updated.
  // If a blog write fails, webhook redelivery can still retry this transition.
  async.each(
    blogs,
    function (blogID, next) {
      setBlog(blogID, { isDisabled: true }, next);
    },
    function (err) {
      if (err) return callback(err);
      set(user.uid, updates, callback);
    }
  );
};
