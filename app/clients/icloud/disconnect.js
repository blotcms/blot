const Blog = require("models/blog");
const database = require("./database");
const placeholders = require("clients/util/placeholders");
const fetch = require("./util/rateLimitedFetchWithRetriesAndTimeout");
const config = require("config");
const seize = require("sync/seize");

const MACSERVER_URL = config.icloud.server_address; // The Macserver base URL from config
const MACSERVER_AUTH = config.icloud.secret; // The Macserver Authorization secret from config

// Tells the Mac server to stop syncing the blog's folder, best effort:
// resolves to a warning when it could not be told, else null.
async function notifyMacserver(blogID) {
  try {
    await fetch(`${MACSERVER_URL}/disconnect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: MACSERVER_AUTH,
        blogID: blogID,
      },
    });
    return null;
  } catch (error) {
    const remoteWarning = {
      event: "icloud-disconnect-remote-failed",
      blogID,
      error: {
        message: error && error.message,
        name: error && error.name,
      },
    };

    // Structured event for deferred cleanup / maintainer follow-up.
    console.warn(
      "icloud-disconnect-remote-failed",
      JSON.stringify(remoteWarning)
    );

    return remoteWarning;
  }
}

// Resolves to the warning when the Mac server could not be told, else null.
//
// The Mac server is told first, so it stops sending changes while the lock
// is taken. The local part runs under the blog's folder lock, taken from any
// sync still running (sync/seize.js): that sync is stopped, and writes
// nothing after the account is deleted, which would otherwise bring back a
// record of the account or leave placeholders behind.
module.exports = async function disconnect(blogID) {
  // Phase A (best effort): notify the Mac server to disconnect.
  const remoteWarning = await notifyMacserver(blogID);

  // Phase B (authoritative local): always disconnect locally.
  await seize(
    blogID,
    async () => {
      await database.delete(blogID);

      // Their bytes are only in iCloud, which Blot can no longer reach
      await placeholders.removeAtDisconnect(blogID);

      await Blog.set(blogID, { client: "" });
    },
    { reason: "disconnect" }
  );

  return remoteWarning;
};

module.exports.notifyMacserver = notifyMacserver;
