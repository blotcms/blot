const database = require("clients/icloud/database");
const Blog = require("models/blog");

module.exports = async function validateBlog(req, res, next) {
  try {
    const blogID = req.header("blogID");

    if (!blogID) {
      console.log("Missing blogID header");
      return res.status(400).send("Missing blogID header");
    }

    // Check with the database that the blog is connected to the iCloud Drive
    const account = await database.get(blogID);

    if (!account || !account.sharingLink) {
      console.log("Blog is not connected to iCloud Drive");
      return res.status(400).send("Blog is not connected to iCloud Drive");
    }

    // A deleted or disabled blog, or one switched to another client, can't
    // sync: the sync would refuse it (sync/index.js). Say so for good, so the
    // macserver drops the change rather than retrying it and asking for
    // resyncs. It keeps watching, so a blog that is enabled again syncs.
    const blog = await Blog.get({ id: blogID });
    if (!blog || blog.isDisabled || blog.client !== "icloud") {
      console.log(`Not syncing ${blogID}: deleted, disabled or not on iCloud`);
      return res.status(410).send("Blog is deleted, disabled or not on iCloud");
    }

    req.account = account;
    next();
  } catch (error) {
    next(error);
  }
};
