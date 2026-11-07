var ensure = require("helper/ensure");
var setBlog = require("models/blog/set");
var set = require("./set");

module.exports = async function disable(user, updates) {
  updates = updates || {};

  ensure(user, "object");
  ensure(updates, "object");

  var blogs = Array.isArray(user.blogs) ? user.blogs.slice() : [];

  updates.isDisabled = true;

  // Keep the persisted account flag unchanged until every blog is updated.
  // If a blog write fails, webhook redelivery can still retry this transition.
  await Promise.all(
    blogs.map(function (blogID) {
      return setBlog(blogID, { isDisabled: true });
    })
  );

  return await set(user.uid, updates);
};
