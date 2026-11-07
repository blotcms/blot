// await establishSyncLock(blogID) resolves to { folder, done }, for callers
// which finish the sync somewhere other than the function that took the
// lock. See sync() in index.js.
module.exports = require("./index").establishSyncLock;
