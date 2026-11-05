var fs = require("fs-extra");
var callbackify = require("util").callbackify;
var ensure = require("helper/ensure");
var withLocalHeld = callbackify(require("build/converters/folderStat").withLocalHeld);
var extname = require("path").extname;
var cheerio = require("cheerio");
var Metadata = require("build/metadata");
var extend = require("helper/extend");
var assets = require("storage/assets");
var pandoc = require("build/converters/pandoc");
var hash = require("helper/hash");

function is (path) {
  return [".odt"].indexOf(extname(path).toLowerCase()) > -1;
}

function read (blog, path, callback) {
  ensure(blog, "object")
    .and(path, "string")
    .and(callback, "function");

  // pandoc keeps the document's own folder names (media/ for docx, Pictures/
  // for odt), so give each document its own directory and commit all of it
  var assetDir = "_assets/" + hash(path);

  // The sandbox streams the file from a local path, and a big document may
  // take it longer than the cache keeps a path, so the file is held
  withLocalHeld(
    blog.id,
    path,
    function (localPath) {
      return pandoc({ from: "odt" }, { path: localPath });
    },
    function (err, file) {
      if (err) return callback(err);

      var stat = file.stat;
      var result = file.value;

      var html = result.html;
      // remove everything between '<!--[if lt IE 9]>' and '<![endif]-->' including those comments
      html = html.replace(
        /<!--\[if lt IE 9\]>[\s\S]*<!\[endif\]-->/g,
        ""
      );

      var $ = cheerio.load(html, { decodeEntities: false }, false);

      // all p that contain possible metadata are checked until one is encountered that does not
      // p that are entirely bold are turned into h tags
      // first p that is entirely bold is h1, next are all h2

      var metadata = {};

      // remove <style>, <meta> and <title>
      $("style").remove();
      $("meta").remove();
      $("title").remove();

      $("p").each(function (i) {
        if ($(this).children().length) return false;

        if (i === 0 && $(this).prev().length) {
          return false;
        }

        var text = $(this).text();

        if (text.indexOf(":") === -1) return false;

        var key = text.slice(0, text.indexOf(":"));

        // Key has space
        if (/\s/.test(key.trim())) return false;

        var parsed = Metadata(text);

        if (parsed.html === text) return false;

        extend(metadata).and(parsed.metadata);

        $(this).remove();
      });

      var titleTag = $("header h1");

      $("header").replaceWith(titleTag);

      // find titles
      // this is possibly? span id="h.ulrsxjddh07w" class="anchor">
      $("p").each(function () {
        var text = $(this).text();
        var strong = $(this).find("strong");
        var strongText = strong.text();
        var children = $(this).children();
        var hasH1 = $("body h1").length;

        if (
          children.length === 1 &&
          text &&
          strongText &&
          text === strongText
        ) {
          var title = $("<h1>");

          if (hasH1) title = $("<h2>");

          title.html(strong.html());

          $(this).replaceWith(title);
        }
      });

      $("a").each(function () {
        var text = $(this).text();
        var em = $(this).find("em");
        var emText = em.text();
        var children = $(this).children();

        if (children.length === 1 && text && emText && text === emText)
          $(this).html(em.html());
      });

      $("li").each(function () {
        var text = $(this).text();
        var blockquote = $(this).find("blockquote");
        var blockquoteText = blockquote.text();
        var children = $(this).children();

        if (
          children.length === 1 &&
          text &&
          blockquoteText &&
          text === blockquoteText
        )
          $(this).html(blockquote.html());
      });

      // fix image links etc...

      $("img").each(function () {
        var src = $(this).attr("src");

        // pandoc's path to a file it extracted becomes the file's asset URL
        if (src.indexOf(result.dir + "/") === 0)
          $(this).attr("src", "/_assets/" + hash(path) + src.slice(result.dir.length));
      });

      html = ($.html() || "").trim();

      var metadataString = "<!--";

      for (var i in metadata)
        metadataString += "\n" + i + ": " + metadata[i];

      if (metadataString !== "<!--") {
        metadataString += "\n-->\n";
        html = metadataString + html;
      }

      // pandoc extracted media from the document, the sandbox passed it back:
      // write it to the blog's asset directory and put it in place
      callbackify(writeMedia)(blog.id, assetDir, result.media, function (err) {
        if (err) return callback(err);

        callback(null, html, stat);
      });
    }
  );
}

async function writeMedia (blogID, assetDir, media) {
  for (var i = 0; i < media.length; i++) {
    await fs.outputFile(assets.path(blogID, assetDir, media[i].name), media[i].data);
  }
  await assets.commit(blogID, assetDir);
}

module.exports = { read: read, is: is, id: "odt" };
