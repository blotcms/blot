var ensure = require("helper/ensure");

var set = require("./set");
var get = require("./get");
var withCallback = require("helper/withCallback");
var isRedisUnavailableError =
  require("helper/redisUnavailable").isRedisUnavailableError;

function sanitize(entry) {
  var now = Date.now();
  var created = typeof entry.created === "number" ? entry.created : now;
  var dateStamp =
    typeof entry.dateStamp === "number" ? entry.dateStamp : created;
  var updated = typeof entry.updated === "number" ? entry.updated : created;

  return {
    id: entry.id || "",
    guid: entry.guid || (entry.id ? "entry_" + entry.id : ""),
    url: entry.url || "",
    permalink: entry.permalink || "",
    title: entry.title || "",
    titleTag: "",
    body: "",
    summary: "",
    teaser: "",
    teaserBody: "",
    more: false,
    html: "",
    slug: entry.slug || "",
    name: entry.name || "",
    path: entry.path || "",
    size: typeof entry.size === "number" ? entry.size : 0,
    tags: [],
    dependencies: [],
    backlinks: [],
    internalLinks: [],
    menu: false,
    page: false,
    deleted: true,
    draft: false,
    scheduled: false,
    thumbnail: {},
    dateStamp: dateStamp,
    created: created,
    updated: updated,
    metadata: {},
    exif: {},
  };
}

// Resolves to set's result, or to undefined when there is no such entry
async function drop(blogID, path) {
  ensure(blogID, "string").and(path, "string");

  var entry;

  try {
    entry = await get(blogID, path);
  } catch (err) {
    // A read that failed because Redis is unavailable says nothing about
    // whether the entry exists. Reporting success would lose the drop.
    if (isRedisUnavailableError(err)) throw err;
  }

  if (!entry) return;

  return await set(blogID, path, sanitize(entry));
}

module.exports = withCallback(drop);
