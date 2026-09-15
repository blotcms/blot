var config = require("config");
var fs = require("fs-extra");
var Mustache = require("mustache");
var render = Mustache.render;

// The script tag inserted into the head of
// every draft preview. This calls Blot's server to update shit
var injectionPath = __dirname + "/preview/injection.html";
var draftContainer = __dirname + "/preview/wrapper.html";

var ensure = require("helper/ensure");
var local_path = require("helper/localPath");

var routePrefix = "/draft";
var viewPrefix = "/view";
var streamPrefix = "/stream";

var extname = require("path").extname;
var basename = require("path").basename;

var PREVIEW_PREFIX = "[preview]";
var PREVIEW_APPENDIX = ".preview.html";
var PREVIEW_META_TAG = '<meta data-blot-document="preview-container"/>';

var DRAFT_PREFIX = "[draft]";
var DRAFT_DIRECTORY = "/drafts/";

// /drafts/foo.txt
// /drafts/foo.preview.html

// /[draft] hello.html
// /[draft] hello.preview.html

// /hello [draft].txt
// /hello [draft].preview.html

var cheerio = require("cheerio");

var streamRoute = routePrefix + streamPrefix + "/*";
var viewRoute = routePrefix + viewPrefix + "/*";

module.exports = (function () {
  function viewURL(handle, filePath) {
    return (
      "http://" + handle + "." + config.host + viewRoute.slice(0, -2) + filePath
    );
  }

  function getPath(url, routeName) {
    // matches the wildcard param, no trailing slash
    var filePath = url.slice(routeName.length - 2);

    // Recode the path
    filePath = decodeURIComponent(filePath);

    return filePath;
  }

  function injectScript(html, filePath, callback) {
    var $;

    try {
      $ = cheerio.load(html || "", { decodeEntities: false });
    } catch (e) {
      return callback(html, html);
    }

    fs.readFile(injectionPath, "utf-8", function (err, scriptTag) {
      if (!err && scriptTag) {
        try {
          scriptTag = Mustache.render(scriptTag, {
            streamURL:
              streamRoute.slice(0, -1) + encodeURIComponent(filePath.slice(1)),
          });
          $("head").append(scriptTag);
        } catch (e) {}
      }

      return callback($.html(), $("body").html());
    });
  }

  function previewFile(handle, path, callback) {
    ensure(handle, "string").and(path, "string").and(callback, "function");

    fs.readFile(draftContainer, "utf-8", function (err, contents) {
      if (err || !contents) return callback(err || "No contents");

      var draftURL = viewURL(handle, path);

      var view = {
        draftURL: draftURL,
        title: basename(path).split("[draft]").join("").trim(),
      };

      try {
        contents = render(contents, view);
      } catch (e) {
        return callback(e);
      }

      return callback(err, contents);
    });
  }

  function previewPath(filePath) {
    ensure(filePath, "string");

    if (filePath.toLowerCase().indexOf(DRAFT_DIRECTORY) > -1)
      return filePath + PREVIEW_APPENDIX;

    filePath = filePath.split(DRAFT_PREFIX).join(PREVIEW_PREFIX);
    filePath += ".html";

    return filePath;
  }

  function isDraft(blog_id, path, callback) {
    var err = null;
    var is_draft = false;
    var name = basename(path) || "";
    var has_prefix = name.slice(0, DRAFT_PREFIX.length) === DRAFT_PREFIX;
    var is_outside_draft_directory =
      path.toLowerCase().indexOf(DRAFT_DIRECTORY) === -1;

    if (has_prefix) {
      is_draft = true;
      // console.log(path, is_draft, 'is a draft because it has the draft prefix');
      return callback(err, is_draft);
    }

    if (is_outside_draft_directory) {
      is_draft = false;
      // console.log(path, is_draft, 'is not a draft because it is outside draft directory');
      return callback(err, is_draft);
    }

    isPreview(blog_id, path, function (err, is_preview) {
      if (err) return callback(err);

      // if the file is inside a draft directory but not itself
      // a preview file then it must be a draft.
      if (is_preview) {
        is_draft = false;
      } else {
        is_draft = true;
      }

      // console.log(path, is_draft, 'is draft?');
      callback(err, is_draft);
    });
  }

  function isPreview(blog_id, path, callback) {
    var err = null;
    var is_preview = false;
    var name = basename(path) || "";
    var extension = extname(path) || "";

    // Preview files are always HTML
    if (extension !== ".html") {
      is_preview = false;
      // console.log(path, is_preview, 'is not a preview file because it is not HTML');
      return callback(err, is_preview);
    }

    // Legacy preview files end in .preview.html
    if (name.slice(-PREVIEW_APPENDIX.length) === PREVIEW_APPENDIX) {
      is_preview = true;
      // console.log(path, is_preview, 'is a preview file because it has the preview appendix');
      return callback(err, is_preview);
    }

    // Legacy preview files might start with [preview]
    if (name.slice(0, PREVIEW_PREFIX.length) === PREVIEW_PREFIX) {
      is_preview = true;
      // console.log(path, is_preview, 'is a preview file because it has the preview prefix');
      return callback(err, is_preview);
    }

    fs.readFile(local_path(blog_id, path), "utf-8", function (err, contents) {
      if (err) return callback(err);

      if (contents.indexOf(PREVIEW_META_TAG) > -1) {
        // console.log(path, is_preview, 'is a preview file because it contains the preview tag');
        is_preview = true;
      }

      // console.log(path, is_preview, 'is a preview file?');
      callback(err, is_preview);
    });
  }

  return {
    getPath: getPath,
    viewURL: viewURL,
    injectScript: injectScript,
    isDraft: isDraft,
    isPreview: isPreview,
    previewFile: previewFile,
    previewPath: previewPath,
    streamRoute: streamRoute,
    viewRoute: viewRoute,
  };
})();
