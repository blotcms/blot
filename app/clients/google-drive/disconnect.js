const Blog = require("models/blog");
const forget = require("./forget");
const placeholders = require("clients/util/placeholders");

async function disconnect(blogID) {
  await forget(blogID);

  // Their bytes are only in Drive, which Blot can no longer reach
  await placeholders.removeAtDisconnect(blogID);

  // An error clearing the blog's client is ignored, as before
  try {
    await Blog.set(blogID, { client: "" });
  } catch (err) {}
}

module.exports = disconnect;
