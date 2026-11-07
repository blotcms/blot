const Blog = require("models/blog");
const database = require("./database");
const fetch = require("./util/rateLimitedFetchWithRetriesAndTimeout");
const config = require("config");

const MACSERVER_URL = config.icloud.server_address; // The Macserver base URL from config
const MACSERVER_AUTH = config.icloud.secret; // The Macserver Authorization secret from config

// Resolves to the warning when the Mac server could not be told, else null.
module.exports = async function disconnect(blogID) {
  let remoteWarning = null;

  try {
    // Phase A (best effort): notify the Mac server to disconnect.
    await fetch(`${MACSERVER_URL}/disconnect`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: MACSERVER_AUTH,
        blogID: blogID,
      },
    });
  } catch (error) {
    remoteWarning = {
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
  }

  // Phase B (authoritative local): always disconnect locally.
  await database.delete(blogID);
  await Blog.set(blogID, { client: "" });

  return remoteWarning;
};
