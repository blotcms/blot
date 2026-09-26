const crypto = require("crypto");
const { promisify } = require("util");
const database = require("../database");

const set = promisify(database.set);

// Stores a connected account with a valid access token and a folder, so
// Graph calls go straight to the (nock-mocked) API.
exports.connect = function (blogID, changes) {
  return set(
    blogID,
    Object.assign(
      {
        account_id: "acct",
        email: "someone@outlook.com",
        access_token: "token",
        refresh_token: "refresh",
        expires_at: Date.now() + 3600 * 1000,
        error_code: 0,
        error_since: 0,
        folder: "Site",
        folder_id: "FOLDER",
        last_sync: 0,
      },
      changes
    )
  );
};

// What Graph reports as a file's sha1Hash
exports.sha1 = function (contents) {
  return crypto.createHash("sha1").update(contents).digest("hex").toUpperCase();
};

// A Graph driveItem for a file or folder
exports.item = function (name, options) {
  options = options || {};

  const item = {
    id: options.id || "id-" + name,
    name,
    size: options.size || 0,
    lastModifiedDateTime: "2026-01-01T00:00:00Z",
  };

  if (options.folder) item.folder = {};
  else item.file = { hashes: { sha1Hash: options.sha1 } };

  return item;
};
