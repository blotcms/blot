var resolve = require("./resolve");
var cheerio = require("cheerio");
var is_url = require("./is_url");
var debug = require("debug")("blot:build:dependencies");
var is_path = require("./is_path");
var extname = require("path").extname;
var metadataCaseInsensitive = require("helper/metadataCaseInsensitive");

// The purpose of this module is to take the HTML for
// a given blog post and work out if it references any
// files in the user's folder. For example, this image
// does: <img src="apple.png"> but this video doesn't:
// <video><source src="//example.com/movie.mp4"></video>
// Our goal is to first resolve all relative file paths
// then determine the list of dependencies. This modifies
// the HTML passed to it.
//
// This includes <a href> as well as <img src> and friends: a
// relative link to a local file is resolved against the file's
// location in the user's folder, not the URL of the post it
// appears on – those are frequently different (e.g. the default
// permalink format is just {{slug}}, unrelated to folder layout).
// This is a deliberate breaking change: previously a relative
// <a href> to a local file was left untouched by the build
// pipeline and resolved (incorrectly, in most cases) against the
// post's published URL by the browser instead.
//
// A relative <a href> is resolved exactly like a relative
// src – no extension filtering, no check that the file exists.
// A link to another post's source file (e.g. other-post.md, or
// page.html) resolves directly to that file, the same as it
// would for an <img src>; it is not resolved against that post's
// permalink. For anything already tagged as a wikilink
// (title="wikilink") - emitted directly from [[...]] syntax by the
// markdown converter - we still track the resolved guess as a
// dependency, but don't rewrite the attribute: the wikilinks
// plugin, which runs after this module, resolves those from their
// original, unresolved target text.
//
// KNOWN EDGE CASE (accepted, not solved): if a relative <a href>
// resolves to a path that happens to be identical to some other
// entry's custom permalink, app/build/prepare/internalLinks.js has
// no way to tell "this is a resolved file reference" apart from "this
// is a real link to that entry" - it'll be counted as the latter,
// producing a spurious backlink on that entry's page. This requires
// an exact, coincidental collision between a resolved file path and
// someone's custom permalink, which is extraordinarily unlikely, and
// the worst case is one wrong entry in a backlinks list - not a
// broken link or lost data. An earlier version of this module threaded
// a "credit" system through here, single.js, and internalLinks.js to
// distinguish the two cases precisely, but the complexity wasn't
// worth what it protected against, so it was removed.

function dependencies (path, html, metadata) {
  // In future it would be nice NOT to reparse the HTML
  // Multiple times. The plugins features also do this.
  var $ = cheerio.load(html, { decodeEntities: false }, false);
  var dependencies = [];
  var attribute, value, resolved_value;
  var metadataByLowercaseKey = metadataCaseInsensitive(metadata);

  // We have to be slightly stricter for
  Object.keys(metadata).forEach(function (attribute) {
    value = metadata[attribute];
    resolved_value = resolve(path, value);

    if (is_url(value)) {
      debug(path, attribute, value, "is a URL");
      return;
    }

    if (!is_path(value)) {
      debug(path, attribute, value, "is not a path");
      return;
    }

    if (dependencies.indexOf(resolved_value) !== -1) {
      debug(path, attribute, resolved_value, "is already on the list");
      return;
    }

    if (dependencies.indexOf(value) !== -1) {
      debug(path, attribute, value, "is already on the list");
      return;
    }

    // Try and resolve the thumbnail path
    // Likewise if it's e.g. ./image.png
    var isThumbnail =
      attribute.toLowerCase() === "thumbnail" &&
      value === metadataByLowercaseKey.thumbnail;

    if (isThumbnail || value.indexOf("./") === 0) {
      dependencies.push(resolved_value);
      metadata[attribute] = resolved_value;
      debug(path, attribute, resolved_value, "was added to dependencies");

      // If the metadata value starts with a slash
      // it's probably a dependency, e.g. /image.png
    } else if (value[0] === "/") {
      dependencies.push(value);
      debug(path, attribute, value, "was added to dependencies");
    }
  });

  // This matches CSS files in the blog post
  // This matches just about everything else,
  // including images, videos, scripts and, now,
  // links to any local file.
  $("link[href], a[href], [src]").each(function () {
    var $el = $(this);
    var isAnchor = $el.is("a");
    var isWikilink = $el.attr("title") === "wikilink";
    var suffix = "";

    if (!!$el.attr("href")) attribute = "href";
    if (!!$el.attr("src")) attribute = "src";

    // Browsers strip all ASCII tab/newline characters (wherever
    // they appear, not just at the ends) and then trim leading/
    // trailing whitespace when parsing a URL - e.g. href="h\ntt
    // ps://example.com/x" is still the external URL "https://
    // example.com/x", and href=" #details" is still an in-page
    // anchor. Match that before classifying the value, or a
    // whitespace-mangled value slips past these checks and gets
    // mistaken for a local path.
    value = ($el.attr(attribute) || "").replace(/[\t\r\n]/g, "").trim();

    if (!value) {
      debug(path, attribute, value, "is empty");
      return;
    }

    if (isAnchor) {
      // Anchors are also used for in-page navigation (footnotes,
      // tables of contents), which isn't a file path – strip any
      // #fragment or ?query before resolving and reattach it after.
      var cutIndex = -1;
      var hashIndex = value.indexOf("#");
      var queryIndex = value.indexOf("?");

      if (hashIndex > -1) cutIndex = hashIndex;
      if (queryIndex > -1 && (cutIndex === -1 || queryIndex < cutIndex))
        cutIndex = queryIndex;

      var pathPart = cutIndex === -1 ? value : value.slice(0, cutIndex);

      suffix = cutIndex === -1 ? "" : value.slice(cutIndex);

      // Browsers treat a backslash the same as a forward slash when
      // parsing a URL for an http(s) page - e.g. "\Files\report.pdf"
      // is root-relative ("/Files/report.pdf") and "\\host\report.pdf"
      // is an external network-path reference ("//host/report.pdf").
      // Normalizing here means the existing is_url/absolute-path
      // checks below already handle both cases correctly.
      pathPart = pathPart.replace(/\\/g, "/");

      if (!pathPart) {
        debug(path, attribute, value, "is a fragment or query only");
        return;
      }

      // Anchors are also used for URI schemes we don't otherwise
      // recognize (javascript:, geo:, magnet:, etc.) - treat any
      // recognizable URI scheme as non-local, not just the specific
      // ones is_url knows about.
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(pathPart) && !is_url(pathPart)) {
        debug(path, attribute, value, "has an unrecognized URI scheme");
        return;
      }

      value = pathPart;
    }

    if (is_url(value)) {
      debug(path, attribute, value, "is a URL");
      return;
    }

    if (!is_path(value)) {
      debug(path, attribute, value, "is not a path");
      return;
    }

    resolved_value = resolve(path, value);

    // path.resolve() drops trailing slashes, and normalizes away
    // trailing dot-segments (e.g. "gallery/." or ".") - but all of
    // these refer to a directory, and need to keep a trailing slash:
    // the browser resolves relative resources inside the linked page
    // differently with and without one.
    var referencesDirectory =
      value.slice(-1) === "/" ||
      value === "." ||
      value === ".." ||
      value.slice(-2) === "/." ||
      value.slice(-3) === "/..";

    if (referencesDirectory && resolved_value.slice(-1) !== "/") {
      resolved_value += "/";
    }

    // A link to a post's own source file resolves to its own path.
    // We still want to rewrite the attribute (see below), but there's
    // no point recording a post as a dependency of itself.
    var isSelfReference = resolved_value === path;

    if (isSelfReference) {
      debug(path, attribute, value, "is the same as its path");
    }

    // Wikilinks ([[Note]] / ![[Image]]) are rendered directly to
    // <a title="wikilink"> / <img title="wikilink"> by the markdown
    // converter, using the raw, unresolved target text. We still
    // track the resolved guess as a dependency, so the post rebuilds
    // automatically if a matching file later appears - but we must
    // not rewrite the attribute itself: the wikilinks plugin, which
    // runs after this module, resolves wikilinks from that original
    // target text, including deliberately leaving it untouched when
    // it can't find a match.
    if (!isWikilink) {
      $el.attr(attribute, resolved_value + suffix);
    }

    if (isSelfReference) {
      return;
    }

    // A wikilink's raw target is only worth tracking as a dependency
    // when it already looks like a file, e.g. ![[pic.png]]. A plain
    // page link like [[target-of-link]] has no extension, so the
    // literal guess (/target-of-link) can never match a real file -
    // the wikilinks plugin tracks the actual resolved file itself.
    if (isWikilink && !extname(value)) {
      debug(path, attribute, value, "wikilink target has no extension");
      return;
    }

    if (dependencies.indexOf(resolved_value) === -1) {
      dependencies.push(resolved_value);
      debug(path, attribute, resolved_value, "was added to dependencies");
    } else {
      debug(path, attribute, resolved_value, "is already on list");
    }
  });

  return {
    html: $.html(),
    dependencies: dependencies,
    metadata: metadata,
  };
}

module.exports = dependencies;
