var callOnce = require("helper/callOnce");
var extname = require("path").extname;
var async = require("async");
var fs = require("fs-extra");
var sharp = require("sharp");

// https://github.com/lovell/sharp/issues/138
// sharp.concurrency(2);
// Not sure why I commented this out? Shit
// https://github.com/lovell/sharp/issues/349
// https://github.com/lovell/sharp/issues/315
// sharp.cache(false);
// Sharp seems to cache files based on their
// path and not the contents of the file at
// a particular path. It was returning stale
// versions of a file in the blog's folder.
// Perhaps it might be smarter to copy the file
// to the temporary directory before operating on it?
// It's also possible that this is a bug in Sharp's
// caching that has been fixed in a more recent version
// or that still needs to be fixed. I should investigate.
sharp.cache(false);

var thumbnails = require("./config").THUMBNAILS;

async function main(path, outputDirectory, callback) {
  var input, result;

  callback = callOnce(callback);
  input = sharp(path, { animated: true})
  result = {};


  async.eachOf(
    thumbnails,
    function (options, name, next) {
      // We want to ensure that this will work on case-sensitive
      // file systems so we lowercase it. In the past we used the
      // original filename for the file in the resulting path but
      // I couldn't work out how to handle filenames like ex?yz.jpg
      // Should I store the name URL-encoded (e.g. ex%3Fyz.jpg)...
      // Now I just use the guuid + size + file extension.
      var extension = extname(path).toLowerCase();

      if (extension === ".svg") extension = ".png";
      
      var fileName = name.toLowerCase() + extension;
      var to = outputDirectory + "/" + fileName;

      transform(input, to, options, function (err, width, height) {
        if (err) return next(err);

        result[name] = {
          width: width,
          height: height,
          name: fileName,
        };

        next();
      });
    },
    function (err) {
      callback(err, result);
    }
  );
}

function transform(input, to, options, callback) {
  var size = options.size;

  var transform = input.clone().rotate();

  transform.on("error", callback);

  
  
  if (options.crop) {
    transform.resize(size, size, {
      withoutEnlargement: true,
      fit: "cover",
    });
  } else {
    transform.resize({ withoutEnlargement: true, fit: "inside", width: size, height: size });
  }

  transform.toFile(to, function done(err, info) {
    if (err) return callback(err);

    callback(err, info.width, info.height);
  });
}

module.exports = main;
