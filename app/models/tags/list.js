const client = require("models/client");
const ensure = require("helper/ensure");
const { normalizePathPrefix, filterEntryIDsByPathPrefix } = require("helper/pathPrefix");
const key = require("./key");

module.exports = async function getAll(blogID, options, callback) {
  try {
    if (typeof options === "function") {
      callback = options;
      options = null;
    }

    ensure(blogID, "string").and(callback, "function");

    options = options || {};
    const pathPrefix = normalizePathPrefix(options.pathPrefix || options.path_prefix);

    const allTags = (await client.sMembers(key.all(blogID))) || [];

    if (allTags.length === 0) {
      return callback(null, []); // No tags to process
    }

    const tags = [];

    if (pathPrefix) {
      // Process one tag at a time rather than fetching every tag's full,
      // unfiltered entry list at once: a blog with many tags and many
      // entries per tag would otherwise hold all of those raw ZRANGE
      // results in memory simultaneously before filtering - working
      // against the exact large-blog memory pressure this is meant to help.
      for (const tag of allTags) {
        const name = (await client.get(key.name(blogID, tag))) || "";
        const entries = filterEntryIDsByPathPrefix(
          (await client.zRange(key.sortedTag(blogID, tag), 0, -1)) || [],
          pathPrefix
        );

        if (!entries.length) continue;

        tags.push({
          name,
          slug: tag,
          entries,
        });
      }

      return callback(null, tags);
    }

    // No path prefix: every read is a small scalar (a name string or a
    // count), so it's safe to fetch every tag's pair at once. Issuing the
    // reads directly with Promise.all (rather than client.multi()/exec())
    // lets node-redis's client-side cache (see app/models/redis.js) serve
    // repeat reads locally - a MULTI/EXEC transaction bypasses that cache
    // entirely, since transaction-queued commands aren't tracked by it.
    const reads = [];
    for (const tag of allTags) {
      reads.push(client.get(key.name(blogID, tag)));
      reads.push(client.zCard(key.sortedTag(blogID, tag)));
    }
    const results = await Promise.all(reads);

    for (let i = 0; i < allTags.length; i++) {
      const tag = allTags[i];
      const name = results[i * 2] || "";
      const count = results[i * 2 + 1] || 0;

      if (count > 0) {
        tags.push({
          name,
          slug: tag,
          entries: new Array(count).fill(null),
        });
      }
    }

    return callback(null, tags);
  } catch (error) {
    return callback(error);
  }
};
