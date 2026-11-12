var { v4: uuid } = require("uuid");
var Transform = require("./transform");
var TransformGIF = require("./transform-gif");
var join = require("path").join;
var assets = require("storage/assets");
var extname = require("path").extname;
// The thumbnail job's jail has the same limit (proxy/unit/sandbox/jail.js)
var TIMEOUT = 20 * 1000; // 20s
var debug = require("debug")("blot:entry:build:thumbnail:create");

async function create(blogID, path) {
  var timeout;

  // Rejects once TIMEOUT has passed. The work below isn't stopped, as before:
  // it carries on and its result is dropped.
  var timedOut = new Promise(function (resolve, reject) {
    timeout = setTimeout(function () {
      debug(blogID, "Timeout reached");
      reject(new Error("Timeout"));
    }, TIMEOUT);
  });

  var work = (async function () {
    var outputDirectory = "/" + join("_thumbnails", uuid());
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

    for (var i in thumbnails) {
      thumbnails[i].path = outputDirectory + "/" + thumbnails[i].name;
      thumbnails[i].url = assets.url(blogID, thumbnails[i].path);
    }

    // The transform wrote the files locally, now they are all in place
    await assets.commit(blogID, outputDirectory);

    debug(blogID, "Done", thumbnails);
    return thumbnails;
  })();

  // If the timeout wins, the work's own failure is not reported
  work.catch(function () {});
  timedOut.catch(function () {});

  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = create;
