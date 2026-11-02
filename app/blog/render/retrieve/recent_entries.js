const Entries = require("models/entries");
const projectEntryFields = require("./helpers/projectEntryFields");
const asRetriever = require("../../lib/asRetriever");

const ALIASES = ["recent_entries"];

// The RSS feed view is fetched by pollers far more often than pages are, so
// it carries fewer entries than the 30 other views get.
const FEED_VIEW_NAME = "feed.rss";
const FEED_MAX_ENTRIES = 10;

// From Entries.getCachedRecent, which caches them per blog cacheID
async function recentEntries(req, res) {
  const log = typeof req?.log === "function" ? req.log.bind(req) : () => {};

  const entries = await Entries.getCachedRecent(req.blog.id, {
    limit: req.viewName === FEED_VIEW_NAME ? FEED_MAX_ENTRIES : undefined,
    cacheID: req.blog.cacheID,
    log,
  });

  return projectEntryFields(entries, req.retrieve, ALIASES);
}

module.exports = asRetriever(recentEntries);
module.exports.FEED_MAX_ENTRIES = FEED_MAX_ENTRIES;
