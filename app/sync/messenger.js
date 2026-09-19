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

    Blog.setStatus(blog.id, { message, syncID });
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
