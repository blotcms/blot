const client = require("models/client");
const ensure = require("helper/ensure");
const type = require("helper/type");
const key = require("./key");
const withCallback = require("helper/withCallback");

module.exports = withCallback(async function getPopular(blogID, options) {
  if (typeof options === "number") {
    options = { limit: options };
  }

  options = options || {};

  ensure(blogID, "string");

  if (!type(options, "object"))
    throw new TypeError("Options must be an object");

  if (options.limit !== undefined) ensure(options.limit, "number");
  if (options.offset !== undefined) ensure(options.offset, "number");

  var limit =
    options.limit !== undefined ? Math.max(0, Math.floor(options.limit)) : 10;
  var offset =
    options.offset !== undefined ? Math.max(0, Math.floor(options.offset)) : 0;

  if (limit === 0) return [];

  const popularityKey = key.popular(blogID);

  const total = await client.zCard(popularityKey);

  if (!total) return [];

  var start = offset;
  var stop = offset + limit - 1;

  const tagScores = await client.zRangeWithScores(popularityKey, start, stop, {
    REV: true,
  });

  if (!tagScores || tagScores.length === 0) {
    return [];
  }

  const tagsWithCounts = [];

  tagScores.forEach(function (item) {
    if (!item || !item.value) return;

    tagsWithCounts.push({
      slug: item.value,
      count: parseInt(item.score, 10) || 0,
    });
  });

  if (!tagsWithCounts.length) {
    return [];
  }

  const details = await Promise.all(
    tagsWithCounts.map(function ({ slug }) {
      return client.get(key.name(blogID, slug));
    })
  );

  const hydrated = [];

  tagsWithCounts.forEach(function ({ slug, count }, index) {
    if (!count) return;

    const name = details[index] || slug;
    const entries = Array.from({ length: count });

    hydrated.push({
      name,
      slug,
      entries,
      count,
    });
  });

  return hydrated;
});
