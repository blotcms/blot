const { popularTags: getPopularTags } = require("../../lib/models");
const asRetriever = require("../../lib/asRetriever");

// A ZRANGE and a GET per tag (the client-side cache usually answers those
// locally), so not worth a cache
async function popularTags(req, res) {
  req.log("Listing popular tags");

  // We could make this limit configurable through req.query or config
  const tags = await getPopularTags(req.blog.id, { limit: 100, offset: 0 });

  req.log("Formatting popular tags");
  return tags.map((tag) => ({
    name: tag.name,
    tag: tag.name, // for backward compatibility
    entries: tag.entries,
    total: tag.count,
    slug: encodeURIComponent(tag.slug),
  }));
}

module.exports = asRetriever(popularTags);
