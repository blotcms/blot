const config = require("config");

// Hostnames that should be treated as "this blog" when rewriting
// absolute asset URLs to CDN URLs in HTML/CSS output.
module.exports = function blogHosts(blog) {
  const hosts = [
    blog.handle + "." + config.host,
    "www." + blog.handle + "." + config.host,
  ];

  if (blog.domain) {
    hosts.push(blog.domain);
    if (blog.domain.startsWith("www.")) {
      hosts.push(blog.domain.slice(4));
    } else {
      hosts.push("www." + blog.domain);
    }
  }

  return hosts;
};
