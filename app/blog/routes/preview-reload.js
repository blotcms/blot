const sse = require("helper/sse")({
  channel: (req) => "blog:" + req.blog.id + ":preview:reload",
});

// Streams a "reload" event on the preview subdomain whenever the blog's
// folder finishes syncing and its rendered output has actually changed
// (see the cacheID update in sync/index.js).
const streamRoute = "/__blot/preview/reload";

module.exports = function register(blog) {
  blog.get(streamRoute, function (req, res, next) {
    if (!req.preview) return next();
    sse(req, res);
  });
};

module.exports.streamRoute = streamRoute;
