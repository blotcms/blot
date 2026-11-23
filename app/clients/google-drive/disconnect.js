const Blog = require("models/blog");
const seize = require("sync/seize");
const forget = require("./forget");
const placeholders = require("clients/util/placeholders");

// Disconnect wins over a running sync: it takes the blog's folder lock from
// whatever holds it (sync/seize.js). The sync is stopped, its requests to
// Drive are cut off, and its writes to the folder and to Drive's records
// throw (database/refuseAfterAbort.js), so it can't write the folder's
// mapping back after forget has deleted it.
async function disconnect(blogID) {
  await seize(blogID, () => forget(blogID), { reason: "disconnect" });

  // Their bytes are only in Drive, which Blot can no longer reach. After the
  // seize, since this takes the lock itself; a sync that starts in between
  // finds no account and does nothing.
  await placeholders.removeAtDisconnect(blogID);

  // An error clearing the blog's client is ignored, as before
  try {
    await Blog.set(blogID, { client: "" });
  } catch (err) {}
}

module.exports = disconnect;
