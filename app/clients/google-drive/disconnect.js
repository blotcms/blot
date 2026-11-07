const Blog = require("models/blog");
const database = require("./database");

async function disconnect(blogID) {
  // Capture the folderId before deleting the account record, otherwise
  // the verified-content cache for this blog's
  // Drive folder become unreachable and leak in Redis permanently.
  const account = await database.blog.get(blogID);

  await database.blog.delete(blogID);

  if (account?.folderId) {
    await database.folder(account.folderId, blogID).reset();
  }

  // An error clearing the blog's client is ignored, as before
  try {
    await Blog.set(blogID, { client: "" });
  } catch (err) {}
}

module.exports = disconnect;
