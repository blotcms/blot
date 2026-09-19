var debug = require("debug")("blot:build:single");
var Metadata = require("./metadata");
var Dependencies = require("./dependencies");
var Plugins = require("./plugins").convert;
var ensure = require("helper/ensure");
var async = require("async");
var enabledConverters = require("./converters/enabled");

module.exports = function (blog, path, callback) {
  ensure(blog, "object").and(path, "string").and(callback, "function");

  async.each(
    enabledConverters(blog),
    function (converter, next) {
      if (!converter.is(path)) return next();

      converter.read(blog, path, function (err, html, stat, extras) {
        if (err) {
          debug("Blog:", blog.id, path, "conversion error", err);
          return callback(err);
        } else {
          debug("Blog:", blog.id, path, "back from converter");
        }

        var parsed, metadata, dependencies;

        // Some converters need to extract metadata before converting the body.
        // Use those original values directly instead of reparsing converted HTML.
        if (extras && extras.preExtractedMetadata) {
          metadata = extras.preExtractedMetadata;
        } else {
          // Now we extract any metadata from the file
          // This modifies the 'contents' if it succeeds
          try {
            parsed = Metadata(html);
            metadata = parsed.metadata;
            html = parsed.html;
          } catch (err) {
            return callback(err);
          }
        }

        // We have to compute the dependencies before
        // passing the contents to the plugins because
        // the image cache plugin replaces local URLs with
        // remove URLs and this will prevent the dependency
        // module from determining which other files in the blog's
        // folder this file depends on.
        try {
          parsed = Dependencies(path, html, metadata);
          dependencies = parsed.dependencies;
          metadata = parsed.metadata;
          html = parsed.html;
        } catch (err) {
          return callback(err);
        }

        debug("Blog:", blog.id, path, "running through plugins");

        // We pass the contents to the plugins for
        // this blog. The resulting HTML is now ready.
        Plugins(blog, path, html, function (err, html, newDependencies) {
          debug("Blog:", blog.id, path, "finished plugins");

          if (err) return callback(err);

          html = fixMustache(html);
          dependencies = Array.from(new Set(dependencies.concat(newDependencies)));

          return callback(null, html, metadata, stat, dependencies, extras);
        });
      });
    },
    function (err) {
      callback(err || cannotConvert(path));
    }
  );
};

function fixMustache(str) {
  return str.split("{{&gt;").join("{{>");
}

function cannotConvert(path) {
  return new Error("Cannot turn this path into an entry: " + path);
}
