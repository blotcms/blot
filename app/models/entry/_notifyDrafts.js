var ensure = require("helper/ensure");
var redis = require("models/client");
var model = require("./model");

module.exports = async function (blogID, entry) {
  ensure(blogID, "string").and(entry, model);

  if (!entry.draft) return;

  var channel = "blog:" + blogID + ":draft:" + entry.path;

  // Now the entry has been updated,
  // tell the server to send a SSE event
  // to any browsers viewing the preview

  // for this entry and refresh the IFRAME

  await redis.publish(channel, Date.now().toString());
};
