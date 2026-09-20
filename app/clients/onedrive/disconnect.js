var Blog = require("models/blog");

// Skeleton implementation: clears blog.client only. Once accounts,
// tokens, delta cursors and Graph subscriptions are stored (PLAN.md,
// "Data to store"), this needs to also delete the subscription, drop
// those keys and clear the refresh token.
module.exports = function disconnect(blogID, callback) {
  Blog.set(blogID, { client: "" }, callback);
};
