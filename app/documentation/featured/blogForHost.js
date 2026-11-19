const config = require("config");
const Blog = require("models/blog");

// The blog a featured site's host (from sites.txt) points to, or undefined.
// A host under blot.im is a handle; any other is a custom domain, which may
// be saved with or without "www.".
module.exports = async function blogForHost(host) {
  const suffix = "." + config.host;

  if (host.endsWith(suffix)) {
    return Blog.get({ handle: host.slice(0, -suffix.length) });
  }

  const bare = host.replace(/^www\./, "");

  return (
    (await Blog.get({ domain: host })) ||
    (await Blog.get({ domain: bare })) ||
    (await Blog.get({ domain: "www." + bare }))
  );
};
