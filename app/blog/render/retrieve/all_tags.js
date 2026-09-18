const { listTags } = require("../../lib/models");
const { normalizePathPrefix } = require("helper/pathPrefix");
const { cloneDeep, prepareCacheValue } = require("../../lib/clone");
const cacheStats = require("../../lib/cacheStats");
const { compactTags, expandTags } = require("./helpers/compactTags");
const LRUCache = require("lru-cache").LRUCache;
const asRetriever = require("../../lib/asRetriever");

// Tag entries are IDs (or nulls for the no-path-prefix count-only branch),
// never full entry bodies, so there's no heavy-field concern here - the
// whole payload is safe to cache as-is.
const allTagsCache = new LRUCache({
  max: 1000,
  maxSize: 50 * 1024 * 1024,
  sizeCalculation: (value) => value.size,
});

function createCacheKey(blog, pathPrefix) {
  return JSON.stringify({
    blogID: String(blog && blog.id),
    cacheID: String(blog && blog.cacheID),
    // Key on the same normalized value models/tags/list.js actually filters
    // by, not the raw pathPrefix - Tags.list treats a non-string as "no
    // filter" and normalizePathPrefix("1") into "/1", so a naive String()
    // key would collide "1" (a real prefix) with 1 (ignored) and serve one
    // view's tag set to the other.
    pathPrefix: normalizePathPrefix(pathPrefix),
  });
}

async function allTags(req, res) {
  const path_prefix =
    res.locals.path_prefix ??
    (req.template && req.template.locals && req.template.locals.path_prefix);

  // Preview renders change on every save and are rarely repeated, so caching
  // them would only thrash the LRU with entries no other request will read.
  const bypassCache = !!req.preview;
  const key = createCacheKey(req.blog, path_prefix);

  if (!bypassCache && allTagsCache.has(key)) {
    req.log("Retrieved all tags from cache");
    const cached = cloneDeep(allTagsCache.get(key).payload);
    res.locals.all_tags_total_posts = cached.totalPosts;
    return expandTags(cached.tags);
  }

  req.log("Listing all tags");
  let tags = await listTags(req.blog.id, { path_prefix });

  // In future, we might want to expose
  // other options for this sorting...
  req.log("Sorting all tags");
  tags = tags.sort(function (a, b) {
    const nameA = a.name.toLowerCase();
    const nameB = b.name.toLowerCase();

    if (nameA < nameB) return -1;
    if (nameA > nameB) return 1;
    return 0;
  });

  const set = {};

  req.log("Counting all tags");
  tags = tags.map((tag) => {
    tag.tag = tag.name;
    tag.total = tag.entries.length;
    tag.entries.forEach((id) => {
      set[id] = true;
    });
    if (tag.slug) tag.slug = encodeURIComponent(tag.slug);
    return tag;
  });

  const totalPosts = Object.keys(set).length;

  if (!bypassCache) {
    allTagsCache.set(
      key,
      prepareCacheValue({ tags: compactTags(tags), totalPosts }),
    );
  }

  // toDO maybe rename this? it's ugly
  res.locals.all_tags_total_posts = totalPosts;

  req.log("Listed all tags");
  return tags;
}

module.exports = asRetriever(allTags);
module.exports._createCacheKey = createCacheKey;
module.exports._clear = function () {
  allTagsCache.clear();
};
module.exports._stats = cacheStats("allTags", allTagsCache);
