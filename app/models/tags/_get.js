const client = require("models/client");
const ensure = require("helper/ensure");
const type = require("helper/type");
const key = require("./key");

// This is a private method which assumes the tag has been normalized.
module.exports = function get(blogID, tag, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }

  options = options || {};

  ensure(blogID, "string").and(tag, "string").and(callback, "function");
  if (!type(options, "object"))
    throw new TypeError("Options must be an object");
  if (options.limit !== undefined) ensure(options.limit, "number");
  if (options.offset !== undefined) ensure(options.offset, "number");

  // The tag's sorted set is scored by dateStamp. REV (the default) gives
  // newest-first; pass rev:false for oldest-first. Either way pagination stays
  // in Redis via zRange start/stop.
  const rev = options.rev !== false;

  var limit =
    options.limit !== undefined
      ? Math.max(0, Math.floor(options.limit))
      : undefined;
  var offset =
    options.offset !== undefined ? Math.max(0, Math.floor(options.offset)) : 0;

  const tagKey = key.name(blogID, tag);
  const sortedTagKey = key.sortedTag(blogID, tag);

  (async function () {
    const pretty = (await client.get(tagKey)) || tag;

    var start = offset;
    var stop = limit === undefined ? -1 : offset + limit - 1;

    const [totalResult, entryIDsResult] = await Promise.all([
      client.zCard(sortedTagKey),
      client.zRange(sortedTagKey, start, stop, { REV: rev }),
    ]);

    const total = totalResult || 0;
    const entryIDs = entryIDsResult || [];

    return callback(null, entryIDs, pretty, total);
  })().catch(callback);
};
