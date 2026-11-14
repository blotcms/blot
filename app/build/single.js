var debug = require("debug")("blot:build:single");
var Metadata = require("./metadata");
var Dependencies = require("./dependencies");
var Plugins = require("./plugins").convert;
var ensure = require("helper/ensure");
var enabledConverters = require("./converters/enabled");
var cheerio = require("cheerio");
var wikilinks = require("./plugins/wikilinks");
var bakeHTML = require("./plugins/folderAssets").bakeHTML;

// Resolves to [html, metadata, stat, dependencies, extras].
// options.inFolderPost is set for each file of a folder post (multiple.js).
async function single(blog, path, options = {}) {
  ensure(blog, "object").and(path, "string");

  // No two converters take the same file extension
  var converter = enabledConverters(blog).find(function (converter) {
    return converter.is(path);
  });

  if (!converter) throw cannotConvert(path);

  var html, stat, extras;

  try {
    [html, stat, extras] = await converter.read(blog, path);
  } catch (err) {
    debug("Blog:", blog.id, path, "conversion error", err);
    throw err;
  }

  debug("Blog:", blog.id, path, "back from converter");

  var parsed, metadata, dependencies;

  // Some converters need to extract metadata before converting the body.
  // Use those original values directly instead of reparsing converted HTML.
  if (extras && extras.preExtractedMetadata) {
    metadata = extras.preExtractedMetadata;
  } else {
    // Now we extract any metadata from the file
    // This modifies the 'contents' if it succeeds
    parsed = Metadata(html);
    metadata = parsed.metadata;
    html = parsed.html;
  }

  // We have to compute the dependencies before
  // passing the contents to the plugins because
  // the image cache plugin replaces local URLs with
  // remove URLs and this will prevent the dependency
  // module from determining which other files in the blog's
  // folder this file depends on.
  parsed = Dependencies(path, html, metadata);
  dependencies = parsed.dependencies;
  metadata = parsed.metadata;
  html = parsed.html;

  // A photo's caption is only for a post made from one image file. The
  // images of a folder post keep the captions they had.
  if (extras && extras.caption && options.inFolderPost) {
    extras = Object.assign({}, extras);
    delete extras.caption;
  }

  // The caption is baked before the plugins run, since the Caption plugin
  // puts it into the post's HTML
  var captionDependencies = [];
  if (extras && extras.caption) {
    var bakedCaption = await bake(blog, path, extras.caption);
    if (bakedCaption) {
      extras.caption = bakedCaption.html;
      captionDependencies = bakedCaption.dependencies;
    }
  }

  debug("Blog:", blog.id, path, "running through plugins");

  // We pass the contents to the plugins for
  // this blog. The resulting HTML is now ready.
  var [pluginHTML, newDependencies] = await Plugins(blog, path, html, {
    caption: extras && extras.caption,
  });

  debug("Blog:", blog.id, path, "finished plugins");

  html = fixMustache(pluginHTML);
  newDependencies = newDependencies.concat(captionDependencies);

  var description = extras && extras.exif && extras.exif.ImageDescription;
  if (typeof description === "string" && description) {
    var bakedDescription = await bake(blog, path, description);
    if (bakedDescription) {
      extras.exif.ImageDescription = bakedDescription.html;
      newDependencies = newDependencies.concat(bakedDescription.dependencies);
    }
  }
  dependencies = Array.from(new Set(dependencies.concat(newDependencies)));

  return [html, metadata, stat, dependencies, extras];
}

module.exports = single;

// An image's ImageDescription and caption are Markdown rendered to HTML
// (converters/img/markdown.js), kept in extras outside the HTML the plugins
// see. Each goes through the same steps as a post's body, in the same order:
// relative links resolved against the image's path, wikilinks (when that
// plugin is enabled), and folder files baked into CDN URLs. Resolves to
// { html, dependencies }, or null when a step fails.
async function bake(blog, path, html) {
  var newDependencies = [];

  try {
    var parsed = Dependencies(path, html, {});
    html = parsed.html;
    newDependencies = newDependencies.concat(parsed.dependencies);

    if (
      html.indexOf("wikilink") > -1 &&
      blog.plugins &&
      blog.plugins.wikilinks &&
      blog.plugins.wikilinks.enabled
    ) {
      var $ = cheerio.load(html, { decodeEntities: false }, false);
      var result = await wikilinks.render($, { blogID: blog.id, path: path });
      html = $.html();
      newDependencies = newDependencies.concat(
        (result && result.newDependencies) || []
      );
    }

    var baked = await bakeHTML(html, {
      blogID: blog.id,
      handle: blog.handle,
      domain: blog.domain,
      path: path,
    });

    return {
      html: baked.html,
      dependencies: newDependencies.concat(baked.dependencies),
    };
  } catch (err) {
    // Like a plugin that fails, the HTML is left as it is
    debug("Blog:", blog.id, path, "description error", err);
    return null;
  }
}

function fixMustache(str) {
  return str.split("{{&gt;").join("{{>");
}

function cannotConvert(path) {
  return new Error("Cannot turn this path into an entry: " + path);
}
