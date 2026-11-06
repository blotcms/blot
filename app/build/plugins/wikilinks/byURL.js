const urlNormalizer = require("helper/urlNormalizer");

module.exports = function byURL(blogID, href, done) {
  const normalizedHref = urlNormalizer(href);
  const { getByUrl } = require("models/entry");

  getByUrl(blogID, normalizedHref, function (entry) {
    if (entry) return done(null, entry);

    done(new Error("No entry found by URL with href: " + href));
  });
};
