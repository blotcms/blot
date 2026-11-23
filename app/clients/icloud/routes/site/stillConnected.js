const Blog = require("models/blog");
const database = require("../../database");

// Whether the blog is still on iCloud, checked again by a route once it
// holds the folder lock. loadAccount checked before the route waited for the
// lock, and a whole disconnect fits in between (sync/seize.js): writing then
// would put a file in the folder of a blog no longer on iCloud.
module.exports = async function stillConnected(blogID) {
  const account = await database.get(blogID);
  if (!account || !account.sharingLink) return false;

  const blog = await Blog.get({ id: blogID });
  return Boolean(blog && !blog.isDisabled && blog.client === "icloud");
};
