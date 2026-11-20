var crypto = require("crypto");
var hashFile = require("helper/transformer/hash");
var THUMBNAILS = require("./config").THUMBNAILS;
var Transform = require("./transform");
var TransformGIF = require("./transform-gif");
var join = require("path").join;
var assets = require("storage/assets");
var extname = require("path").extname;
// The thumbnail job's jail has the same limit (proxy/unit/sandbox/jail.js)
var TIMEOUT = 20 * 1000; // 20s
var debug = require("debug")("blot:entry:build:thumbnail:create");

// Bump to give every thumbnail a new directory, and so a new URL, after a
// change to how they're made that the sizes below don't show (quality, a
// sharp upgrade): the CDN and browsers keep these files for a year.
var VERSION = "1";

// An image's thumbnails live in a directory named for its bytes and how
// they're made, so a build that makes them again (a second build of the same
// image at once, a job that outlived the build's wait, a lost cache entry)
// writes the same files to the same place, rather than leaving another
// directory behind.
function directoryForHash(hash) {
  var name = crypto
    .createHash("sha256")
    .update(VERSION + "\n" + JSON.stringify(THUMBNAILS) + "\n")
    .update(hash)
    .digest("hex")
    .slice(0, 32);

  return "/" + join("_thumbnails", name);
}

async function directoryFor(path) {
  return directoryForHash(await hashFile(path));
}

// Gives the thumbnails Transform wrote to outputDirectory their paths and
// URLs, and commits the directory, once they are all in place
async function publish(blogID, outputDirectory, thumbnails) {
  for (var i in thumbnails) {
    thumbnails[i].path = outputDirectory + "/" + thumbnails[i].name;
    thumbnails[i].url = assets.url(blogID, thumbnails[i].path);
  }

  await assets.commit(blogID, outputDirectory);

  return thumbnails;
}

// Thumbnails being made in this process, by blog and directory: a second build of the
// same image waits for the first rather than writing the same files under it
var making = new Map();

async function create(blogID, path) {
  var timeout;

  // Rejects once TIMEOUT has passed. The work below isn't stopped, as before:
  // it carries on and its result is dropped.
  var timedOut = new Promise(function (resolve, reject) {
    timeout = setTimeout(function () {
      debug(blogID, "Timeout reached");
      var err = new Error("Timeout");
      err.timedOut = true;
      reject(err);
    }, TIMEOUT);
  });

  var work = (async function () {
    var outputDirectory = await directoryFor(path);
    var key = blogID + outputDirectory;

    if (making.has(key)) return making.get(key);

    var made = make(outputDirectory);
    making.set(key, made);

    try {
      return await made;
    } finally {
      making.delete(key);
    }
  })();

  // If the timeout wins, the work's own failure is not reported
  work.catch(function () {});
  timedOut.catch(function () {});

  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timeout);
  }

  async function make(outputDirectory) {
    var fullPathToOutputDirectory = assets.path(blogID, outputDirectory);
    var extension = extname(path).toLowerCase();

    var transform = extension === ".gif" ? TransformGIF : Transform;
    var thumbnails;

    // The thumbnail job checks the image can be a thumbnail before it makes any
    debug(blogID, "Transforming", path);

    try {
      thumbnails = await transform(path, fullPathToOutputDirectory);
    } catch (err) {
      if (err && err.invalid)
        debug(blogID, "Invalid thumbnail candidate", path, err);
      throw err;
    }

    // The transform wrote the files locally, now they are all in place
    await publish(blogID, outputDirectory, thumbnails);

    debug(blogID, "Done", thumbnails);
    return thumbnails;
  }
}

module.exports = create;
module.exports.directoryForHash = directoryForHash;
module.exports.publish = publish;
