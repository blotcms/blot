const shouldIgnoreFile = require("clients/util/shouldIgnoreFile");

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

  // Drive keeps names in whatever Unicode form they were uploaded in (macOS
  // uploads are often NFD), but localPath writes NFC. Comparing the raw names
  // against the local folder would never match, so every sync would delete
  // the local copy and download it again.
  for (const item of items) item.name = item.name.normalize();

  // Filter out system files that shouldn't be synced to Blot
  return items.filter((item) => !shouldIgnoreFile(item.name));
};

module.exports = readdir;
