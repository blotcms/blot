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
  return async function main(path, outputDirectory) {
    // We want to ensure that this will work on case-sensitive
    // file systems so we lowercase it. In the past we used the
    // original filename for the file in the resulting path but
    // I couldn't work out how to handle filenames like ex?yz.jpg
    // Should I store the name URL-encoded (e.g. ex%3Fyz.jpg)...
    // Now I just use the guuid + size + file extension.
    var extension = outputExtension(path);

    var reply = await sandbox.run("thumbnail", request(extension, animated), {
      path: path,
    });

    return write(reply, extension, outputDirectory);
  };
}

// The extension of a file's thumbnails: its own, and PNG for an SVG
function outputExtension(path) {
  var extension = extname(path).toLowerCase();

  return extension === ".svg" ? ".png" : extension;
}

// The thumbnail job's arguments for an image's thumbnails. The image plugin
// sends the same to the resize job (./seed.js), which makes them from the
// image it has just written.
function request(extension, animated) {
  var names = Object.keys(thumbnails);

  return {
    extension: extension,
    animated: animated,
    sizes: names.map(function (name) {
      return { size: thumbnails[name].size, crop: !!thumbnails[name].crop };
    }),
    accept: validate.ACCEPT,
  };
}

// Checks the job's reply, and writes its thumbnails to outputDirectory. The
// directory is made only for an image that passes, and an image that doesn't
// fails with the reason, with err.invalid set.
async function write(reply, extension, outputDirectory) {
  var names = Object.keys(thumbnails);
  var meta = reply.meta;

  if (!meta || typeof meta !== "object")
    throw new Error("Unexpected thumbnail result");

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

module.exports = make(false);
module.exports.animated = make(true);
module.exports.request = request;
module.exports.write = write;
module.exports.outputExtension = outputExtension;
