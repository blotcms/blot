const urlNormalizer = require("helper/urlNormalizer");
const withCallback = require("helper/withCallback");

module.exports = function byURL(blogID, href, done) {
  const normalizedHref = urlNormalizer(href);
  const { getByUrl } = require("models/entry");

  // A failed lookup is the same as no entry
  withCallback(getByUrl)(blogID, normalizedHref, function (err, entry) {
    if (entry) return done(null, entry);

    done(new Error("No entry found by URL with href: " + href));
  });
};
