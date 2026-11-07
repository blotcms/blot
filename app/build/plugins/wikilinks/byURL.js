const urlNormalizer = require("helper/urlNormalizer");

async function byURL(blogID, href) {
  const normalizedHref = urlNormalizer(href);
  const { getByUrl } = require("models/entry");
  let entry;

  // A failed lookup is the same as no entry
  try {
    entry = await getByUrl(blogID, normalizedHref);
  } catch (err) {
    entry = null;
  }

  if (entry) return entry;

  throw new Error("No entry found by URL with href: " + href);
}

module.exports = byURL;
