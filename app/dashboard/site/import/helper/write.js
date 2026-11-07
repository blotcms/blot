var fs = require("fs-extra");
var path = require("path");

var MAX_NAME_LENGTH = 150;

function createWriter() {
  var reserved = new Set();

  return async function write(post) {
    var basePath = allocate(post, reserved);
    var hasAssets = Boolean(
      post.asset_directory && fs.existsSync(post.asset_directory)
    );
    var finalPath = hasAssets
      ? path.join(basePath, "post.txt")
      : basePath + ".txt";

    post.path = basePath;
    post.content = post.content.trim();

    await moveAssets(post.asset_directory, basePath);

    await fs.outputFile(finalPath, post.content);

    var atime = Date.now();
    var mtime = post.updated || post.created || post.dateStamp || Date.now();
    await fs.utimes(finalPath, atime, mtime);
  };
}

function allocate(post, reserved) {
  var originalPath = post.path;
  var originalName = path.basename(originalPath);
  var directory = path.dirname(originalPath);
  var number = 1;

  while (true) {
    var suffix = number === 1 ? "" : "-" + number;
    var name = originalName.slice(0, MAX_NAME_LENGTH - suffix.length) + suffix;
    var candidate = path.join(directory, name);
    var key = path.normalize(candidate);

    if (
      !reserved.has(key) &&
      !fs.existsSync(candidate) &&
      !fs.existsSync(candidate + ".txt")
    ) {
      reserved.add(key);
      return candidate;
    }

    number += 1;
  }
}

async function moveAssets(source, destination) {
  if (!source || !fs.existsSync(source)) return;

  await fs.ensureDir(destination);
  const names = await fs.readdir(source);

  // Every move settles before the first error is thrown
  const results = await Promise.allSettled(
    names.map((name) =>
      fs.move(path.join(source, name), path.join(destination, name))
    )
  );
  const failed = results.find((result) => result.status === "rejected");

  if (failed) throw failed.reason;

  await fs.remove(source);
}

// Retain the single-entry middleware API for callers outside the batch import.
// Each standalone write gets its own allocation state; batch imports should use
// createWriter() to share reservations across entries in the same import.
async function write(post) {
  return createWriter()(post);
}

module.exports = write;
module.exports.createWriter = createWriter;
