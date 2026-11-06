const database = require("clients/icloud/database");

module.exports = (blogID) => {
  return async () => {
    const account = await database.get(blogID);
    if (!account) throw new Error("Blog not found");
  };
};
