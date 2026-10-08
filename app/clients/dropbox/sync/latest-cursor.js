const { promisify } = require("util");
const { SOURCES } = require("../util/classifyError");
const tagSource = require("../util/tagSource");
const createClient = promisify((blogID, cb) =>
  require("../util/createClient")(blogID, (err, ...results) => cb(err, results))
);

// It's important that these args match those used in delta.js
// A way to quickly get a cursor for the folder's state.
// From the docs:
// https://dropbox.github.io/dropbox-sdk-js/Dropbox.html
// Unlike list_folder, list_folder/get_latest_cursor doesn't
// return any entries. This endpoint is for app which only
// needs to know about new files and modifications and doesn't
// need to know about files that already exist in Dropbox.
// Route attributes: scope: files.metadata.read
async function latestCursor(client, account) {
  const {
    result: { cursor },
  } = await tagSource(
    SOURCES.DELTA,
    client.filesListFolderGetLatestCursor({
      path: account.folder_id || "",
      include_deleted: true,
      recursive: true,
    })
  );

  return cursor;
}

// For callers that have no client yet, e.g. validation fetching a cursor
// ahead of taking the folder lock (see reset-to-blot's excuseChangesSince).
async function latestCursorForBlog(blogID) {
  const [client, account] = await createClient(blogID);
  return latestCursor(client, account);
}

module.exports = latestCursor;
module.exports.forBlog = latestCursorForBlog;
