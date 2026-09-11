var url = require("url");
var config = require("config");

// Paths app/blog/assets.js mounts globally, ahead of the blog's own
// folder (see GLOBAL_STATIC_SUBDIRECTORIES there). A blog folder can
// coincidentally contain a file at one of these paths too, but the live
// site never serves it - the global asset always shadows it - so we must
// not "helpfully" resolve these locally, or we'd serve different bytes
// than the URL actually returns.
var RESERVED_PREFIXES = ["/fonts/", "/icons/", "/katex/", "/plugins/"];

// Strips a leading "www." so we treat the www and bare-domain forms of a
// hostname as equivalent without needing to be strict about which one a
// particular URL uses.
function stripWWW(hostname) {
  return hostname.indexOf("www.") === 0 ? hostname.slice(4) : hostname;
}

// Returns the set of hostnames (lowercased, "www." stripped) a blog is
// reachable at: its custom domain, if any, and its <handle>.blot.im
// subdomain.
function hostnames(source) {
  source = source || {};

  var hosts = [];

  if (source.domain)
    hosts.push(stripWWW(String(source.domain).toLowerCase()));

  if (source.handle)
    hosts.push(String(source.handle).toLowerCase() + "." + config.host);

  return hosts;
}

// If `src` is a fully-qualified URL whose host is one of `ownHostnames`,
// returns the blog-root-relative path it maps onto (query string and hash
// dropped, since those don't correspond to anything on disk). Returns null
// if `src` isn't hosted on one of these hostnames.
function resolve(src, ownHostnames) {
  if (!ownHostnames || !ownHostnames.length) return null;

  // isURL.js treats a protocol-relative "//host/path" as an implicit
  // http(s) URL, so we need to match that here too or we'd silently miss
  // this (fairly common, e.g. copy-pasted from a CMS) form entirely.
  if (src.indexOf("//") === 0) src = "http:" + src;

  var parsed;

  try {
    parsed = url.parse(src);
  } catch (e) {
    return null;
  }

  if (!parsed.hostname) return null;

  // An explicit non-default port means this URL points at a different
  // service running on the blog's domain, not necessarily the blog
  // itself - don't assume it maps onto the blog's own folder. An
  // explicit *default* port (:80 for http, :443 for https) is the same
  // origin as no port at all, so that's fine.
  var defaultPort = parsed.protocol === "https:" ? "443" : "80";
  if (parsed.port && parsed.port !== defaultPort) return null;

  var hostname = stripWWW(parsed.hostname.toLowerCase());

  if (ownHostnames.indexOf(hostname) === -1) return null;

  var pathname = (parsed.pathname || "/").toLowerCase();

  if (RESERVED_PREFIXES.some(function (prefix) {
    return pathname.indexOf(prefix) === 0;
  }))
    return null;

  return parsed.pathname || "/";
}

module.exports = {
  hostnames: hostnames,
  resolve: resolve
};
