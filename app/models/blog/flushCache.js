const BackupDomain = require("./util/backupDomain");
const config = require("config");
const flush = require("helper/flushProxies");
const debug = require("debug")("blot:blog:flushCache");
const get = require("./get");
const promiseOnly = require("helper/promiseOnly");

// This empties the cache for a blog by emptying the cache
// for its Blot subdomain and its custom domain, if one is set.
// You can optionally pass the former state of the blog to ensure that the
// cache directories for old domains and blot subdomains are flushed too.
module.exports = promiseOnly(async function flushCache(blogID, former = {}) {
  const blogHosts = [];
  const affectedHosts = [];

  const blog = await get({ id: blogID });

  if (blog.domain) {
    blogHosts.push(blog.domain);
    affectedHosts.push(blog.domain);
    blogHosts.push(BackupDomain(blog.domain));
    affectedHosts.push(BackupDomain(blog.domain));
  }

  if (blog.handle) {
    blogHosts.push(blog.handle + "." + config.host);
    affectedHosts.push(blog.handle + "." + config.host);
  }

  if (former.handle && former.handle !== blog.handle) {
    affectedHosts.push(former.handle + "." + config.host);
  }

  if (former.domain && former.domain !== blog.domain) {
    affectedHosts.push(former.domain);
    affectedHosts.push(BackupDomain(former.domain));
  }

  // We make sure to empty cache directories when deleting a blog
  // This can be done in the background since it's not critical
  if (affectedHosts.length) {
    debug("blog.flushCache: hosts", affectedHosts);
    flush(affectedHosts)
      .then(() => {
        debug("blog.flushCache: directories flushed for:", affectedHosts);
      })
      .catch((error) => {
        console.error("blog.flushCache: flushing cache directories:", error);
      });
  } else {
    debug("blog.flushCache: no cache directories to flush for blog", blogID);
  }
});
