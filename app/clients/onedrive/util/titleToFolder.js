// OneDrive rejects names containing these characters, and names ending in
// a dot or space.
module.exports = function titleToFolder(title) {
  let folder = String(title || "")
    .replace(/[\\/:*?"<>|]/g, "")
    .trim()
    .replace(/[. ]+$/, "");

  return folder || "Untitled";
};
