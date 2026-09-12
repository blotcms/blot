const Blog = require("models/blog");
const database = require("./database");

module.exports = async (blogID, callback) => {

    // Capture the folderId before deleting the account record, otherwise
    // the verified-content cache and migration cursor for this blog's
    // Drive folder become unreachable and leak in Redis permanently.
    const account = await database.blog.get(blogID);

    await database.blog.delete(blogID);

    if (account?.folderId) {
        await database.folder(account.folderId, blogID).reset();
    }

    Blog.set(blogID, { client: "" }, async function (err) {
        callback();
    });
};