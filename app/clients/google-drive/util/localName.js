// The name a Drive item has in the blog folder. It must match what localPath
// writes, or sync never finds the local copy and deletes and downloads it
// again on every run. Drive keeps names in whatever Unicode form they were
// uploaded in (macOS uploads are often NFD) but localPath writes NFC. Drive
// also allows '/' in names: localPath drops a trailing slash (so '_images/'
// is stored as '_images') and any other slash would nest the file in a
// subfolder.
module.exports = function localName(name) {
  return name.normalize().replace(/\/+$/, "").replace(/\//g, "_") || "_";
};
