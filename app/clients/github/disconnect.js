var Blog = require("models/blog");

// Skeleton implementation: clears blog.client only. Once the Redis
// schema for installations/repos/tokens exists (PLAN.md, "Data to
// store"), this needs to also drop those keys and the installation ->
// blogs / repo -> blog indexes, without uninstalling the GitHub App
// (another Blot site may share the installation).
module.exports = function disconnect(blogID, callback) {
  Blog.set(blogID, { client: "" }, callback);
};
