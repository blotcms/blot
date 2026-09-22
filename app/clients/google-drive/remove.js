// Service accounts are down. Restore the previous remove from git history.
module.exports = function remove(blogID, path, callback) {
  callback(new Error("Google Drive sync is paused"));
};
