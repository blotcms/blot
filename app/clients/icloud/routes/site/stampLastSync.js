const database = require("../../database");
const clfdate = require("helper/clfdate");

// Records that the macserver just pushed something for this blog, which is
// what makes the hourly sweep (init.js) check it. Only routes driven by the
// macserver's watcher call this - never a walk Blot starts itself, or the
// sweep would keep every blog it checks eligible forever. A failed stamp
// only means the blog is skipped by one sweep, so it never fails the route.
module.exports = async function stampLastSync(blogID) {
  try {
    await database.stampLastSync(blogID);
  } catch (err) {
    console.error(clfdate(), "iCloud: Failed to stamp lastSync", blogID, err);
  }
};
