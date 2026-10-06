const database = require("../database");
const sync = require("./sync");

module.exports = async (blogID, publish, update) => {
  publish = publish || function () {};
  update = update || function () {};

  const account = await database.blog.get(blogID);
  const { pruneVerifiedContents } = database.folder(account.folderId, blogID);

  // sync resets the database state of the folder once it has confirmed
  // the folder is still reachable
  const summary = await sync(blogID, publish, update, { reset: true });

  if (summary) await pruneVerifiedContents();

  return summary;
};
