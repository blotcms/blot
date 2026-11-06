var ensure = require("helper/ensure");
var withCallback = require("helper/withCallback");
var setBlog = require("models/blog/set");
var set = require("./set");

module.exports = withCallback(async function enable(user, updates) {
  updates = updates || {};

  ensure(user, "object");
  ensure(updates, "object");

  var blogs = Array.isArray(user.blogs) ? user.blogs.slice() : [];

  updates.isDisabled = false;

  // Keep the persisted account flag unchanged until every blog is updated.
  // If a blog write fails, webhook redelivery can still retry this transition.
  await Promise.all(
    blogs.map(function (blogID) {
      return setBlog(blogID, { isDisabled: false });
    })
  );

  return await set(user.uid, updates);
});
