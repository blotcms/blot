var config = require("config");
var fs = require("fs-extra");
var Mustache = require("mustache");
var render = Mustache.render;

// The script tag inserted into the head of
// every draft preview. This calls Blot's server to update shit
var injectionPath = __dirname + "/preview/injection.html";
var draftContainer = __dirname + "/preview/wrapper.html";

var ensure = require("helper/ensure");
var storage = require("storage/folder");

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

// The routes end in an optional wildcard, which Express 5 needs named:
// /draft/view/{*splat} matches /draft/view/ and everything below it
var WILDCARD = "{*splat}";
var streamRoute = routePrefix + streamPrefix + "/" + WILDCARD;
var viewRoute = routePrefix + viewPrefix + "/" + WILDCARD;

module.exports = (function () {
  function viewURL(handle, filePath) {
    return (
      "http://" +
      handle +
      "." +
      config.host +
      viewRoute.slice(0, -(WILDCARD.length + 1)) +
      filePath
    );
  }

  function getPath(url, routeName) {
    // matches the wildcard param, no trailing slash
    var filePath = url.slice(routeName.length - (WILDCARD.length + 1));

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
              streamRoute.slice(0, -WILDCARD.length) +
              encodeURIComponent(filePath.slice(1)),
          });
          $("head").append(scriptTag);
        } catch (e) {}
      }

      return callback($.html(), $("body").html());
    });
  }

  async function previewFile(handle, path) {
    ensure(handle, "string").and(path, "string");

    var contents = await fs.readFile(draftContainer, "utf-8");

    if (!contents) throw "No contents";

    var draftURL = viewURL(handle, path);

    var view = {
      draftURL: draftURL,
      title: basename(path).split("[draft]").join("").trim(),
    };

    return render(contents, view);
  }

  function previewPath(filePath) {
    ensure(filePath, "string");

    if (filePath.toLowerCase().indexOf(DRAFT_DIRECTORY) > -1)
      return filePath + PREVIEW_APPENDIX;

    filePath = filePath.split(DRAFT_PREFIX).join(PREVIEW_PREFIX);
    filePath += ".html";

    return filePath;
  }

  async function isDraft(blog_id, path) {
    var name = basename(path) || "";
    var has_prefix = name.slice(0, DRAFT_PREFIX.length) === DRAFT_PREFIX;
    var is_outside_draft_directory =
      path.toLowerCase().indexOf(DRAFT_DIRECTORY) === -1;

    if (has_prefix) return true;

    if (is_outside_draft_directory) return false;

    // if the file is inside a draft directory but not itself
    // a preview file then it must be a draft.
    return !(await isPreview(blog_id, path));
  }

  async function isPreview(blog_id, path) {
    var name = basename(path) || "";
    var extension = extname(path) || "";

    // Preview files are always HTML
    if (extension !== ".html") return false;

    // Legacy preview files end in .preview.html
    if (name.slice(-PREVIEW_APPENDIX.length) === PREVIEW_APPENDIX) return true;

    // Legacy preview files might start with [preview]
    if (name.slice(0, PREVIEW_PREFIX.length) === PREVIEW_PREFIX) return true;

    var buffer = await storage.read(blog_id, path);
    var contents = buffer.toString("utf-8");

    return contents.indexOf(PREVIEW_META_TAG) > -1;
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
