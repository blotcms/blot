const database = require("clients/google-drive/database");

module.exports = (blogID, initialAccount) => {
  return async () => {
    const account = await database.blog.get(blogID);
    if (!account) throw new Error("Blog not found");
    if (account.folderId !== initialAccount.folderId)
      throw new Error("Folder ID changed");
    if (!account.serviceAccountId)
      throw new Error("Service account ID not found");
    if (account.preparing !== initialAccount.preparing)
      throw new Error("Preparing has changed");
  };
};
