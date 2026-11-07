var User = require("models/user");
var Blog = require("models/blog");
var parseUrl = require("url").parse;

// A failed lookup has always counted as "no match" here, so its error is
// dropped rather than failing the whole lookup
async function ignoreErrors(lookup) {
  try {
    return await lookup();
  } catch (err) {
    return undefined;
  }
}

async function getByPrefix(identifier) {
  var blogIDS = await Blog.getAllIDs();
  var id = blogIDS.filter((id) => id.indexOf(identifier) === 0)[0];
  if (!id) throw new Error("no blog");
  return Blog.get({ id });
}

async function find(identifier) {
  var domain;
  var handle;

  handle = identifier;

  var identifierWithoutTrailingSlash = (identifier || "").replace(/\/+$/, "");
  var identifierForParsing = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(
    identifierWithoutTrailingSlash
  )
    ? identifierWithoutTrailingSlash
    : "https://" + identifierWithoutTrailingSlash;

  try {
    var parsed = parseUrl(identifierForParsing.toLowerCase());

    if (parsed && parsed.host) {
      // Map 'preview.default.foo.blot.im' -> 'foo.blot.im'
      if (parsed.host.indexOf("preview.") === 0)
        domain = parsed.host.split(".").slice(-3).join(".");
      else domain = parsed.host;
    }
  } catch (e) {}

  if (!domain) domain = identifierWithoutTrailingSlash.toLowerCase();

  var blogFromID = await ignoreErrors(() => Blog.get({ id: identifier }));
  var blogFromDomain = await ignoreErrors(() => Blog.get({ domain: domain }));
  var blogFromHandle = await ignoreErrors(() => Blog.get({ handle: handle }));
  var blogByPrefix = await ignoreErrors(() => getByPrefix(identifier));

  if (!blogFromDomain && !blogFromHandle && !blogFromID && !blogByPrefix)
    throw new Error("No blog");

  var blog = blogFromID || blogFromHandle || blogFromDomain || blogByPrefix;

  var user = await User.getById(blog.owner);
  if (!user) throw new Error("No user");

  var url = await require("../blog/access")(blog.handle);

  return { user, blog, url };
}

// Takes a URL or handle and resolves { user, blog, url }, where url is a
// one-time dashboard log-in link. Throws if there is no such blog or user.
module.exports = find;
