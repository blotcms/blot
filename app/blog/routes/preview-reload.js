const previewReload = require("helper/publishPreviewReload");

const sse = require("helper/sse")({
  channel: (req) => previewReload.channel(req.blog.id),
});

// Streams a "reload" event on the preview subdomain. Folder sync publishes
// after it bumps cacheID, and template editor saves of package.json locals
// publish the same event (they update Redis without a folder sync).
const streamRoute = "/__blot/preview/reload";

module.exports = function register(blog) {
  blog.get(streamRoute, function (req, res, next) {
    if (!req.preview) return next();
    sse(req, res);
  });
};

module.exports.streamRoute = streamRoute;
