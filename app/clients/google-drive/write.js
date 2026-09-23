// Service accounts are down. Restore the previous write from git history.
module.exports = function write(blogID, path, input, callback) {
  callback(new Error("Google Drive sync is paused"));
};
