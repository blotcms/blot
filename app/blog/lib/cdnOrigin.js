const config = require("config");
const fromCloudflare = require("./fromCloudflare");

// The real CDN origin, downgraded to http when the request itself was
// served over http and isn't behind Cloudflare.
module.exports = function cdnOrigin(req) {
  let origin = config.cdn.origin;

  if (req.protocol === "http" && fromCloudflare(req) === false) {
    origin = origin.split("https://").join("http://");
  }

  return origin;
};
