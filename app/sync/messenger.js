const client = require("models/client");
const clfdate = require("helper/clfdate");
const { v4: uuid } = require("uuid");
const Blog = require("models/blog");

// Will log, and then send any updates to the client
// via a SSE event, and store updates in redis
module.exports = (blog) => {
  const syncID = "sync_" + uuid().slice(0, 7);
  const log = function () {
    console.log.apply(null, [
      clfdate(),
      blog.id.slice(0, 12),
      syncID,
      "client=" + (blog.client || "none"),
      ...arguments,
    ]);
  };
  const status = function () {
    const message = [...arguments].join(" ").trim();

    // Not awaited: a sync must not wait on its status write, but a failed
    // write is logged rather than dropped.
    Blog.setStatus(blog.id, { message, syncID }, (err) => {
      if (err) log("failed to store sync status", err.message);
    });
    log(message);
    client
      .publish("sync:status:" + blog.id, message)
      .catch((err) => log("failed to publish sync status", err.message));
  };
  return {
    log,
    status,
    syncID,
  };
};
