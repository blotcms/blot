var fs = require("fs-extra");

module.exports = async function (post) {
  await fs.outputFile(post.path, post.content);

  // Set the files atime (access time) and mtime (last-modified)
  // I really just want to set the mtime but it doesn't seem
  // possible to modify it using the fs module without doing atime
  var atime = Date.now();
  var mtime = post.updated || Date.now();

  await fs.utimes(post.path, atime, mtime);
};
