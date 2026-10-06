const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");
const localName = require("../../util/localName");

const readdir = async (drive, dirId) => {
  let res;
  let items = [];
  let nextPageToken;

  do {
    const params = {
      q: `'${dirId}' in parents and trashed = false`,
      pageToken: nextPageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields:
        "nextPageToken, files/id, files/name, files/modifiedTime, files/md5Checksum, files/mimeType, files/size",
    };
    res = await drive.files.list(params);
    items = items.concat(res.data.files);
    nextPageToken = res.data.nextPageToken;
  } while (nextPageToken);

  // Sync compares these names with the local folder's.
  for (const item of items) item.name = localName(item.name);

  // Filter out system files that shouldn't be synced to Blot
  return items.filter((item) => !shouldIgnoreFile(item.name));
};

module.exports = readdir;
