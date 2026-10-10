const mime = require("mime-types");

// The Content-Type for a path, by its extension. A path with no "." is taken
// to be a page (the blog folder's extensionless fallbacks); anything else
// unknown is application/octet-stream. Shared by the routes which serve
// files and by the S3 upload, so an object has the type it is served with.
module.exports = function contentTypeFor(path) {
  const isDirectory = path.indexOf(".") === -1;
  const defaultMime = isDirectory ? "text/html" : "application/octet-stream";
  let contentType = mime.contentType(mime.lookup(path) || defaultMime);

  if (contentType === "application/mp4") {
    contentType = "video/mp4";
  }

  return contentType;
};
