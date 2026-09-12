const database = require("../database");
const sync = require("./sync");

module.exports = async (blogID, publish, update) => {
  publish = publish || function () {};
  update = update || function () {};

  const account = await database.blog.get(blogID);
  const { reset, pruneVerifiedContents } = database.folder(account.folderId, blogID);

  // reset the database state of the folder
  await reset({ preserveVerifiedContent: true });

  if (await sync(blogID, publish, update)) await pruneVerifiedContents();
};
