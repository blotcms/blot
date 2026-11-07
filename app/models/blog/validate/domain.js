var ensure = require("helper/ensure");
var punycode = require("helper/punycode");
var url = require("url");
var HOST =
  /^(([a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])\.)*([A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9])$/;

var INVALID = "Please enter a valid hostname";
var IN_USE = "That domain was already in use.";
var SUBDOMAIN =
  "Do not enter a Blot subdomain. This is for custom domains only.";
var TOO_LONG = "Please choose a domain shorter than 70 letters.";

var config = require("config");
var promiseOnly = require("helper/promiseOnly");

// Resolves to the valid domain. Rejects with a message (a string) or an Error.
module.exports = promiseOnly(async function validateDomain(blogID, domain) {
  var get = require("../get");

  try {
    ensure(blogID, "string").and(domain, "string");

    domain = domain.replace(" ", "");
    domain = domain.trim();
    domain = domain.toLowerCase();

    if (!domain) return "";

    // http://google.com -> google.com
    if (domain.indexOf("://") > -1) domain = url.parse(domain).hostname;

    // mañana.com -> xn--maana-pta.com
    domain = punycode.toASCII(domain);
  } catch (e) {
    throw INVALID;
  }

  if (!HOST.test(domain)) {
    throw INVALID;
  }

  if (domain.endsWith(config.host)) {
    throw SUBDOMAIN;
  }

  if (domain.length > 70) {
    throw new Error(TOO_LONG);
  }

  // A failed lookup is treated as the domain being free, as it was
  var blog;
  try {
    blog = await get({ domain: domain });
  } catch (err) {}

  if (blog && blog.id && blog.id !== blogID) {
    throw IN_USE;
  }

  return domain;
});
