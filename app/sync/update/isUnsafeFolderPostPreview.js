var pathNormalizer = require("helper/pathNormalizer");

// A folder post is synthesized at an extensionless path with no file behind
// it. Outside /drafts/, previewPath("/album") is the bare "/album.html",
// which could be a real sibling source file, so a draft folder post there
// must not write or remove a filesystem preview. Inside /drafts/ the preview
// gets the safe ".preview.html" appendix, so the normal flow is fine.
module.exports = function isUnsafeFolderPostPreview(targetPath, entryHtml) {
  return (
    typeof entryHtml === "string" &&
    entryHtml.indexOf('class="multi-file-post"') !== -1 &&
    pathNormalizer(targetPath).toLowerCase().indexOf("/drafts/") === -1
  );
};
