const Tags = require("models/tags");
const client = require("models/client");
const tagKey = require("models/tags/key");
const { filterEntryIDsByPathPrefix } = require("helper/pathPrefix");
const { getEntry } = require("../../lib/models");
const asRetriever = require("../../lib/asRetriever");
const tagSlug = require("./helpers/tagSlug");

// Fields a tag's latest entry doesn't need in a list of tags: its body could
// be long, and a page of tags shows each one's title and picture.
const HEAVY_FIELDS = ["html", "body", "teaser", "teaserBody"];

// How many of each tag's newest entries `entries` holds.
const ENTRIES_PER_TAG = 12;

// Every tag, the one with the most recent entry first, each with that entry
// as `entry`: for an index of tags that leads with what changed last. When the
// view reads `entries` (a strip of each tag's pictures, say), each tag also
// gets its newest ENTRIES_PER_TAG entries there; otherwise only the newest is
// read. One ZRANGE per tag and one read of those entries, so not cached.
async function recentTags(req, res) {
  const path_prefix =
    res.locals.path_prefix ??
    (req.template && req.template.locals && req.template.locals.path_prefix);

  req.log("Listing recent tags");
  const tags = await Tags.getCachedList(req.blog.id, {
    pathPrefix: path_prefix,
    cacheID: req.blog.cacheID,
    log: req.log,
  });

  // Each tag's newest entry IDs: the top of its date-sorted set, or with a
  // path prefix the newest ones under it.
  const withEntries = Boolean(req.retrieve && req.retrieve.entries);
  const count = withEntries ? ENTRIES_PER_TAG : 1;
  const latestIDs = await Promise.all(
    tags.map(async (tag) => {
      const key = tagKey.sortedTag(req.blog.id, tag.slug);
      if (!path_prefix) {
        return (await client.zRange(key, 0, count - 1, { REV: true })) || [];
      }
      const ids = await client.zRange(key, 0, -1, { REV: true });
      return filterEntryIDsByPathPrefix(ids || [], path_prefix).slice(0, count);
    })
  );

  const wanted = [...new Set(latestIDs.flat().filter(Boolean))];
  const entries = wanted.length ? await getEntry(req.blog.id, wanted) : [];
  const byID = new Map();
  for (const entry of entries || []) {
    if (!entry || !entry.id) continue;
    for (const field of HEAVY_FIELDS) delete entry[field];
    byID.set(entry.id, entry);
  }

  req.log("Sorting recent tags");
  return tags
    .map((tag, i) => {
      const found = latestIDs[i].map((id) => byID.get(id)).filter(Boolean);
      const item = {
        name: tag.name,
        tag: tag.name, // for backward compatibility, as all_tags has
        slug: tag.slug ? tagSlug(tag.slug) : tag.slug,
        total: tag.entries.length,
        entry: found[0],
      };
      if (withEntries) item.entries = found;
      return item;
    })
    .filter((tag) => tag.entry)
    .sort((a, b) => (b.entry.dateStamp || 0) - (a.entry.dateStamp || 0));
}

module.exports = asRetriever(recentTags);
