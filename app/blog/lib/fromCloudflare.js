// Detect Cloudflare-proxied requests. Some Cloudflare SSL modes fetch from
// the origin over HTTP, which would cause mixed-content warnings or redirect
// loops if we treated those as plain HTTP clients.
module.exports = function fromCloudflare(req) {
  return (
    Object.keys(req.headers || {})
      .map((key) => key.trim().toLowerCase())
      .find((key) => key.startsWith("cf-")) !== undefined
  );
};
