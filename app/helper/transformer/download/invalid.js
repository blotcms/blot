var protocols = ["http:", "https:"];
var Url = require("url");

// Cheap sanity check on a URL before we try to download it. This is NOT the
// SSRF control - destination IP filtering (private ranges, cloud metadata,
// DNS-rebinding) happens in the airlock container, see config/airlock.
// Rejecting credentials in the URL here just removes a common trick for
// hiding an internal host from a naive check.
function invalid(url) {
  var parsed;

  try {
    parsed = Url.parse(url);
  } catch (e) {
    return new Error("Could not parse " + url);
  }

  if (!parsed.host || !parsed.protocol)
    return new Error("Has no host or protocol " + url);

  if (protocols.indexOf(parsed.protocol) === -1)
    return new Error("Has unsupported protocol " + url);

  // Don't echo the URL here - this branch is reached precisely when it may
  // carry credentials, and this error can end up in logs.
  if (parsed.auth) return new Error("URL must not contain credentials");

  return false;
}

module.exports = invalid;
