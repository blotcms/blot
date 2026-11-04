var callOnce = require("helper/callOnce");
var extname = require("path").extname;
var fs = require("fs-extra");
var sandbox = require("sandbox");
var validate = require("./validate");

var thumbnails = require("./config").THUMBNAILS;

// Makes every size in the config from one image, once the job has checked it
// can be a thumbnail (./validate). The sharp work happens in the sandbox's
// thumbnail job (app/sandbox/jobs/thumbnail.js); the files are written here,
// since the sandbox can't reach the blog's folder. The output directory is
// made only for an image that passes, and an image that doesn't fails with
// the reason, with err.invalid set.
function make(animated) {
  return function main(path, outputDirectory, callback) {
    callback = callOnce(callback);

    // We want to ensure that this will work on case-sensitive
    // file systems so we lowercase it. In the past we used the
    // original filename for the file in the resulting path but
    // I couldn't work out how to handle filenames like ex?yz.jpg
    // Should I store the name URL-encoded (e.g. ex%3Fyz.jpg)...
    // Now I just use the guuid + size + file extension.
    var extension = extname(path).toLowerCase();

    if (extension === ".svg") extension = ".png";

    var names = Object.keys(thumbnails);
    var sizes = names.map(function (name) {
      return { size: thumbnails[name].size, crop: !!thumbnails[name].crop };
    });

    async function work() {
      var reply = await sandbox.run(
        "thumbnail",
        { extension: extension, animated: animated, sizes: sizes, accept: validate.ACCEPT },
        { path: path }
      );

      var meta = reply.meta;
      if (!meta || typeof meta !== "object") throw new Error("Unexpected thumbnail result");

      var invalid = validate.check(meta.source);
      if (invalid || meta.thumbnails === null) {
        invalid = invalid || new Error("Image is not a valid thumbnail");
        invalid.invalid = true;
        throw invalid;
      }

      if (
        !Array.isArray(meta.thumbnails) ||
        meta.thumbnails.length !== names.length ||
        reply.outputs.length !== names.length
      ) {
        throw new Error("Unexpected thumbnail result");
      }

      await fs.ensureDir(outputDirectory);

      var result = {};

      await Promise.all(
        names.map(async function (name, i) {
          var fileName = name.toLowerCase() + extension;

          await fs.writeFile(outputDirectory + "/" + fileName, reply.outputs[i]);

          result[name] = {
            width: meta.thumbnails[i].width,
            height: meta.thumbnails[i].height,
            name: fileName,
          };
        })
      );

      return result;
    }

    work().then(
      function (result) {
        callback(null, result);
      },
      function (err) {
        callback(err);
      }
    );
  };
}

module.exports = make(false);
module.exports.animated = make(true);
