var debug = require("debug")("blot:build:multiple");
var path = require("path");
var async = require("async");
var fs = require("fs-extra");
var localPath = require("helper/localPath");
var ensure = require("helper/ensure");
var pathNormalizer = require("helper/pathNormalizer");
var Single = require("./single");
var enabledConverters = require("./converters/enabled");
var titlecase = require("helper/titlecase");
var cheerio = require("cheerio");

// Mirrors the traversal in prepare/title.js exactly: preferred tag order and
// the "first three nodes at each nesting level" limit.
var TITLE_TAG_ORDER = ["h4", "h3", "h2", "h1"];
var TITLE_MAX_DEPTH = 3;

var MAX_MULTI_FILES = 50;

module.exports = function buildMultiple(blog, info, callback) {
  ensure(blog, "object")
    .and(info, "object")
    .and(info.folderPath, "string")
    .and(info.entryPath, "string")
    .and(callback, "function");

  const folderPath = pathNormalizer(info.folderPath);
  const entryPath = pathNormalizer(info.entryPath);

  debug("Blog:", blog.id, "building multiple for", folderPath);

  // A folder like "/article.md+" strips to "/article.md", which can also be a
  // real sibling file with its own entry. Refuse to aggregate in that case so
  // the two identities don't overwrite each other depending on sync order.
  fs.stat(localPath(blog.id, entryPath), function (statErr, entryStat) {
    if (!statErr && entryStat.isFile()) {
      var collisionError = new Error(
        "Folder post path collides with a file: " + entryPath
      );
      collisionError.code = "PLUS_PATH_COLLISION";
      return callback(collisionError);
    }

    collectConvertibleFiles(blog, folderPath, onFiles);
  });

  function onFiles(err, files) {
    if (err) return callback(err);

    if (!files.length) {
      var emptyError = new Error(
        "No convertible files inside multi folder: " + folderPath
      );
      emptyError.code = "EMPTY";
      return callback(emptyError);
    }

    async.mapSeries(
      files,
      function (filePath, next) {
        Single(blog, filePath, function (
          err,
          html,
          metadata,
          stat,
          dependencies,
          extras,
        ) {
          if (err) {
            debug("Blog:", blog.id, filePath, "error building", err);
            return next(err);
          }

          next(null, {
            path: filePath,
            html: html,
            metadata: metadata || {},
            stat: stat || {},
            dependencies: dependencies || [],
            extras: extras || {},
          });
        });
      },
      function (err, results) {
        if (err) return callback(err);

        var combinedMetadata = {};
        var combinedDependencies = [];
        var combinedExtras = {};
        var combinedStat = {
          size: 0,
          mtime: 0,
          ctime: 0,
        };

        results.forEach(function (result) {
          combinedMetadata = mergeMetadata(combinedMetadata, result.metadata);
          combinedDependencies = combinedDependencies.concat(result.dependencies);
          combinedExtras = mergeMetadata(combinedExtras, result.extras);

          if (result.stat && typeof result.stat.size === "number") {
            combinedStat.size += result.stat.size;
          }

          if (result.stat && result.stat.mtime) {
            combinedStat.mtime = Math.max(
              combinedStat.mtime,
              new Date(result.stat.mtime).valueOf()
            );
          }

          if (result.stat && result.stat.ctime) {
            combinedStat.ctime = Math.max(
              combinedStat.ctime,
              new Date(result.stat.ctime).valueOf()
            );
          }
        });

        combinedDependencies = Array.from(new Set(combinedDependencies));

        var stat = {
          size: combinedStat.size,
        };

        if (combinedStat.mtime) stat.mtime = new Date(combinedStat.mtime);
        if (combinedStat.ctime) stat.ctime = new Date(combinedStat.ctime);

        if (!stat.mtime) stat.mtime = new Date();

        var metadata = Object.assign({}, combinedMetadata, {
          _sourcePaths: files,
        });

        var html = renderHtmlSections(results, folderPath, combinedMetadata);

        debug(
          "Blog:",
          blog.id,
          "multi entry",
          entryPath,
          "built from",
          files.length,
          "files"
        );

        callback(null, html, metadata, stat, combinedDependencies, combinedExtras);
      }
    );
  }
};

function collectConvertibleFiles(blog, folderPath, callback) {
  const files = [];

  function walk(currentPath, done) {
    if (files.length > MAX_MULTI_FILES) {
      return done(createTooManyFilesError(folderPath));
    }

    const absolute = localPath(blog.id, currentPath);

    fs.readdir(absolute, { withFileTypes: true }, function (err, entries) {
      if (err) return done(err);

      entries = entries.slice().sort(function (a, b) {
        return a.name.localeCompare(b.name, "en");
      });

      async.eachSeries(
        entries,
        function (entry, next) {
          if (files.length > MAX_MULTI_FILES) {
            return next(createTooManyFilesError(folderPath));
          }

          const entryPath = pathNormalizer(
            path.join(currentPath, entry.name)
          );

          if (shouldIgnore(entryPath)) return next();

          if (entry.isDirectory()) {
            if (entry.name.endsWith("+") && entryPath !== folderPath) {
              return next();
            }

            return walk(entryPath, next);
          }

          if (isPreviewFile(entry.name)) return next();

          if (!isConvertible(blog, entryPath)) return next();

          files.push(entryPath);

          if (files.length > MAX_MULTI_FILES) {
            return next(createTooManyFilesError(folderPath));
          }

          next();
        },
        done
      );
    });
  }

  walk(folderPath, function (err) {
    if (err) return callback(err);
    files.sort(function (a, b) {
      return a.localeCompare(b, "en");
    });
    callback(null, files);
  });
}

function createTooManyFilesError(folderPath) {
  var err = new Error(
    "Multi-folder contains more than " + MAX_MULTI_FILES + " convertible files"
  );
  err.code = "TOO_MANY_FILES";
  err.folderPath = folderPath;
  err.limit = MAX_MULTI_FILES;
  return err;
}

function renderHtmlSections(results, folderPath, metadata) {
  var sections = results.map(function (result, index) {
    var attributes = [
      'class="multi-file-entry"',
      'data-file="' + escapeAttribute(result.path) + '"',
      'data-index="' + index + '"',
    ];

    var extension = path.extname(result.path).slice(1);

    if (extension) {
      attributes.push(
        'data-extension="' + escapeAttribute(extension.toLowerCase()) + '"'
      );
    }

    var innerHtml = result.html || "";

    return (
      "\n  <section " +
      attributes.join(" ") +
      ">\n" +
      innerHtml +
      "\n  </section>"
    );
  });

  var combinedHtml = sections.join("");
  var headerHtml = deriveHeading(folderPath, combinedHtml, metadataTitle(metadata));

  return (
    '<section class="multi-file-post" data-folder="' +
    escapeAttribute(folderPath) +
    '">' +
    headerHtml +
    combinedHtml +
    "\n</section>"
  );
}

function deriveHeading(folderPath, combinedHtml, explicitTitle) {
  // prepare/title.js only inspects the first three top-level nodes when it
  // picks the entry title, so an <h1> beyond the first three source sections
  // is invisible to it. Mirror that limit: only skip the generated heading
  // when a heading title.js can actually reach already exists, otherwise the
  // stored title/slug fall back to the folder name while the rendered post
  // shows a heading from a later file.
  if (hasReachableH1(combinedHtml)) return "";

  // Prefer an explicit `Title:` from the merged metadata so the injected
  // heading matches entry.title; fall back to the folder name.
  var title = explicitTitle || deriveTitleFromFolder(folderPath);

  if (!title) return "";

  return (
    '\n  <h1 class="multi-file-title">' +
    escapeHtml(title) +
    "</h1>"
  );
}

// True when prepare/title.js would actually resolve an <h1> as the entry
// title from these sections. It only ever inspects the first three nodes at
// each nesting level (see the `find` loop in prepare/title.js), so an <h1>
// buried past that - either as a later source section or past the first
// three nodes within an early one - is not "reachable" and must not suppress
// the generated heading.
function hasReachableH1(combinedHtml) {
  var $ = cheerio.load(
    String(combinedHtml || ""),
    { decodeEntities: false, withDomLvl1: false },
    false
  );

  var titleNode = null;

  function bestTag(first, second) {
    if (!first || !first.name) return second;
    if (!second || !second.name) return first;
    if (TITLE_TAG_ORDER.indexOf(second.name) > TITLE_TAG_ORDER.indexOf(first.name))
      return second;
    return first;
  }

  function find(i, node) {
    if (i >= TITLE_MAX_DEPTH) return false;

    titleNode = bestTag(titleNode, node);

    if (titleNode.name === "h1") return false;

    $(node).children().each(find);
  }

  $.root().children().each(find);

  return !!(titleNode && titleNode.name === "h1");
}

function metadataTitle(metadata) {
  if (!metadata) return "";

  var key = Object.keys(metadata).filter(function (candidate) {
    return String(candidate).toLowerCase() === "title";
  })[0];

  if (!key) return "";

  var value = metadata[key];

  return typeof value === "string" ? value.trim() : "";
}

function deriveTitleFromFolder(folderPath) {
  if (!folderPath) return "";

  var base = path.basename(folderPath);

  if (!base) return "";

  var withoutSuffix = base.replace(/\+$/, "");

  if (!withoutSuffix) return "";

  var decoded = withoutSuffix;

  try {
    decoded = decodeURIComponent(withoutSuffix);
  } catch (error) {}

  var spaced = decoded.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();

  if (!spaced) return "";

  return titlecase(spaced);
}

function isConvertible(blog, filePath) {
  return enabledConverters(blog).some(function (converter) {
    return converter.is(filePath);
  });
}

function isPreviewFile(name) {
  return (
    name.endsWith(".preview.html") ||
    name.toLowerCase().indexOf("[preview]") > -1
  );
}

function shouldIgnore(entryPath) {
  const normalized = pathNormalizer(entryPath).toLowerCase();

  if (!normalized || normalized === "/") return false;

  return (
    normalized.startsWith("/public/") ||
    normalized.includes("/_") ||
    normalized.includes("/.") ||
    // textbundle asset files are dependencies of their .textbundle, not
    // standalone content - matches the rule in app/sync/update/set.js
    normalized.includes(".textbundle/assets/")
  );
}

function mergeMetadata(target, source) {
  target = target || {};
  source = source || {};

  var result = {};

  Object.keys(target).forEach(function (key) {
    result[key] = cloneValue(target[key]);
  });

  Object.keys(source).forEach(function (rawKey) {
    var incoming = source[rawKey];

    // Resolve every repeated key case-insensitively ("Title" vs "title",
    // "Tags" vs "tags") so both spellings merge into one key instead of
    // surviving as two - otherwise a later file's `title` cannot override an
    // earlier file's `Title` the way the documented merge order promises.
    var key = rawKey;
    var existingKey = Object.keys(result).filter(function (candidate) {
      return candidate.toLowerCase() === String(rawKey).toLowerCase();
    })[0];
    if (existingKey) key = existingKey;

    if (Array.isArray(result[key]) && Array.isArray(incoming)) {
      // Tags are documented as unioned across every source file; any other
      // repeated array key (Authors, ...) follows the same "later file wins"
      // rule as a scalar - an empty incoming array does not clobber it.
      if (isTagKey(key)) {
        result[key] = Array.from(new Set(result[key].concat(incoming)));
      } else if (incoming.length) {
        result[key] = cloneValue(incoming);
      }
      return;
    }

    if (isPlainObject(result[key]) && isPlainObject(incoming)) {
      result[key] = mergeMetadata(result[key], incoming);
      return;
    }

    // "Tags: one, two" reaches us as a string, so without this every source
    // file after the first would have its tags dropped. Union them instead.
    if (isTagKey(key) && isTagValue(result[key]) && isTagValue(incoming)) {
      result[key] = mergeTagValues(result[key], incoming);
      return;
    }

    // Documented behavior: for a repeated scalar key (Title, Link, Draft, …)
    // later source files override earlier ones. An absent/empty incoming
    // value does not clobber a value an earlier file already set.
    if (incoming !== undefined && incoming !== null && incoming !== "") {
      result[key] = cloneValue(incoming);
    } else if (result[key] === undefined) {
      result[key] = cloneValue(incoming);
    }
  });

  Object.keys(result).forEach(function (key) {
    if (result[key] === undefined) delete result[key];
  });

  return result;
}

function isTagKey(key) {
  return String(key).toLowerCase() === "tags";
}

function isTagValue(value) {
  return typeof value === "string" ? value.trim() !== "" : Array.isArray(value);
}

function mergeTagValues(existing, incoming) {
  var seen = new Set();
  var merged = [];

  toTagList(existing)
    .concat(toTagList(incoming))
    .forEach(function (tag) {
      var trimmed = String(tag).trim();
      if (!trimmed) return;
      var dedupeKey = trimmed.toLowerCase();
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
      merged.push(trimmed);
    });

  return merged.join(", ");
}

function toTagList(value) {
  if (Array.isArray(value)) return value;
  return String(value).split(",");
}

function escapeAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.slice();
  if (isPlainObject(value)) {
    var cloned = {};
    Object.keys(value).forEach(function (key) {
      cloned[key] = cloneValue(value[key]);
    });
    return cloned;
  }
  return value;
}

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}
