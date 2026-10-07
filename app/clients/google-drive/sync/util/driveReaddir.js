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
  const renamed = new Set();
  for (const item of items) {
    const name = localName(item.name);
    if (name !== item.name) renamed.add(item);
    item.name = name;
  }

  // Siblings can share a local name (Drive allows duplicate names, and
  // 'AC/DC.jpg' maps to 'AC_DC.jpg'). transformDriveItems suffixes all but
  // the first, and Drive's listing order isn't stable, so sort to keep each
  // item on the same local path between syncs: an item already named as it
  // is locally keeps that name, then by id.
  items.sort(
    (a, b) =>
      renamed.has(a) - renamed.has(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );

  // Filter out system files that shouldn't be synced to Blot
  return items.filter((item) => !shouldIgnoreFile(item.name));
};

module.exports = readdir;
