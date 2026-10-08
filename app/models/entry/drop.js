var ensure = require("helper/ensure");

var set = require("./set");
var get = require("./get");
var isRedisUnavailableError = require("helper/redisUnavailable").isRedisUnavailableError;

function sanitize(entry) {
  var now = Date.now();
  var created = typeof entry.created === "number" ? entry.created : now;
  var dateStamp = typeof entry.dateStamp === "number" ? entry.dateStamp : created;
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

module.exports = function drop(blogID, path, callback) {
  ensure(blogID, "string").and(path, "string").and(callback, "function");

  get(blogID, path, function (entry, err) {
    if (!entry) {
      // A read that failed because Redis is unavailable says nothing about
      // whether the entry exists. Reporting success would lose the drop.
      return callback(err && isRedisUnavailableError(err) ? err : undefined);
    }

    set(blogID, path, sanitize(entry), callback);
  });
};
