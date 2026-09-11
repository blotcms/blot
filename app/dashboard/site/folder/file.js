const debug = require("debug")("blot:dashboard:folder:kind");
const path = require("path");
const basename = path.basename;
const extname = path.extname;
const Entry = require("models/entry");
const IgnoredFiles = require("models/ignoredFiles");
const moment = require("moment");
const converters = require("build/converters");
const enabledConverters = require("build/converters/enabled");
const Build = require("build");
const fs = require("fs-extra");
const localPath = require("helper/localPath");
const postSourceSize = require("build/converters/post-source-size");
const Stat = require("./stat");

// Mirror the folder-post viewer: show the first N source files inline, hide the
// rest behind a "Show all" toggle.
const VISIBLE_SOURCE_LIMIT = 10;

require("moment-timezone");

const findMultiFolder =
  (Build && Build.findMultiFolder) ||
  function () {
    return null;
  };

const SYNTHETIC_DEPENDENCY_PREFIXES = [
  "/__wikilink_slug__/",
  "/__wikilink_filename__/",
];

module.exports = async function (blog, path) {
  return new Promise((resolve, reject) => {
    const blogID = blog.id;

    const multiInfo = findMultiFolder(path);
    const aggregatedLookupPath = multiInfo ? multiInfo.entryPath : null;

    Promise.all([
      new Promise((resolve, reject) => {
        IgnoredFiles.getStatus(blogID, path, function (err, ignored) {
          if (err) return reject(err);
          resolve(ignored);
        });
      }),
      new Promise((resolve) => {
        Entry.get(blogID, path, function (entry) {
          resolve(entry);
        });
      }),
      new Promise((resolve) => {
        if (!aggregatedLookupPath || aggregatedLookupPath === path) {
          return resolve(null);
        }

        Entry.get(blogID, aggregatedLookupPath, function (entry) {
          resolve(entry);
        });
      }),
    ])
      .then(async ([ignoredReason, ownEntry, aggregatedEntry]) => {
        const matchingConverter = converters.find((converter) => {
          return converter.is(path);
        });
        const matchingConverterEnabled = enabledConverters(blog).some(
          (converter) => {
            return matchingConverter && converter.id === matchingConverter.id;
          }
        );

        let entry = resolveDisplayedEntry({
          path,
          ownEntry,
          aggregatedEntry,
          multiInfo,
        });

        const entryLookupPath = entry ? entry.path : path;

        let ignored = {};

        if (!entry) {

          if (
            ignoredReason &&
            ignoredReason === 'WRONG_TYPE' &&
            matchingConverter &&
            matchingConverter.id === "img" &&
            !matchingConverterEnabled
          ) {
            ignored.imageConverterDisabled = true;
          } else if (ignoredReason && ignoredReason === 'WRONG_TYPE') {
            ignored.wrongType = true;
          } else if (path.toLowerCase().indexOf("/templates/") === 0) {
            ignored.templateFile = true;
          } else if (
            path.split("/").slice(0,-1).filter(function (n) {
              return n[0] === "_";
            }).length) {
            ignored.underscorePath = true;
          } else if (basename(path)[0] === "_") {
            ignored.underscoreName = true;
          } else if (ignoredReason && ignoredReason === 'TOO_LARGE') {
            ignored.tooLarge = true;
            ignored.postSizeLimit = postSourceSize.limitForPath(path).label;
          } else  {
            ignored.syncing = true;
          }
        }

        const file = {};

        file.kind = kind(path, entry, multiInfo);
        file.path = path;
        file.url = encodePath(path);
        file.name = basename(path);
        file.entryPath = entryLookupPath;

        // a dictionary we use to display conditionally in the UI
        file.extension = {};
        file.extension = normalizeExtension(path)
        file.converter = matchingConverter || null;
        file.converterEnabled = matchingConverterEnabled;
        
        file.entry = entry;
        file.ignored = ignored;

        if (entry) {
          // Replace with case-preserving
          entry.name = file.name;

          let converter;

          if (isMultiEntry(entry, multiInfo)) {
            entry.converter = { multi: true };
          } else {
            converter = converters.find((converter) => {
              return converter.is(path);
            });

            if (converter) {
              entry.converter = {};
              entry.converter[converter.id] = true;
            } else {
              entry.converter = {};
            }
          }

          entry.type = entry.draft ? 'draft' : entry.page ? 'page' :  'post';
          entry.Type = entry.type.charAt(0).toUpperCase() + entry.type.slice(1);

          entry.tags = entry.tags.map((tag, i, arr) => {
            return { tag, first: i === 0, last: i === arr.length - 1 };
          });

          entry.date = moment
            .utc(entry.dateStamp)
            .tz(blog.timeZone)
            .format("MMMM Do YYYY, h:mma");

          if (entry.draft) {
            entry.url = "/draft/view" + entry.path;
          }

          entry.backlinks = entry.backlinks.map((backlink) => {
            return  { backlink};
          });

          entry.dependencies = entry.dependencies
            .filter((dependency) => {
              return !isSyntheticDependency(dependency);
            })
            .map((dependency) => {
            return { dependency };
            });

          entry.internalLinks = entry.internalLinks.map((internalLink) => {
            return { internalLink };
          });

          const rawMetadata = { ...(entry.metadata || {}) };
          const sourcePaths = sourcePathsForEntry(entry, multiInfo);

          if (sourcePaths.length && isMultiEntry(entry, multiInfo)) {
            delete rawMetadata._sourcePaths;

            const folderDetails =
              multiInfo ||
              (sourcePaths.length
                ? findMultiFolder(sourcePaths[0])
                : null) || { entryPath: entry.path };

            entry.multi = await buildMultiEntryData({
              blogID,
              entry,
              folderDetails,
              sourcePaths,
              currentPath: path,
              timeZone: blog.timeZone,
            });
          }

          entry.metadata = Object.keys(rawMetadata).map((key) => {
            return { key, value: rawMetadata[key] };
          });

          if (entry.exif && typeof entry.exif === "object") {
            const exif = entry.exif;
            entry.exif = Object.keys(exif).map((key) => {
              return { key, value: exif[key] };
            });
          } else {
            entry.exif = [];
          }

          if (entry.scheduled) {
            entry.url += "?scheduled=true";
            entry.toNow = moment.utc(entry.dateStamp).fromNow();
          }
        }
        
        resolve(file);
      })
      .catch((err) => {
        reject(err);
      });
  });
};



// https://fileinfo.com/filetypes/common

const KIND = {
  txt: "Plain text document",
  jpg: "JPG image",
  jpeg: "JPEG image",
  odt: "OpenDocument Text document",
  rtf: "Rich Text File",
  doc: "Microsoft Word document",
  docx: "Microsoft Word document",
  ai: "Adobe Illustrator document",
  js: "JavaScript file",
  css: "Cascading Style Sheet",
  html: "HTML document",
};

const CATEGORIES = {
  "image": ["jpg", "jpeg", "png", "gif", "bmp", "tiff"],
  "audio": ["mp3", "wav", "wma", "ogg", "flac", "aac"],
  "video": ["mp4", "avi", "mkv", "mov", "flv", "wmv"],
};

function kind(path, entry, multiInfo) {
  if (entry && isMultiEntry(entry, multiInfo)) {
    return "Folder post";
  }

  let kind = "File";
  let extension;

  extension = extname(path).toLowerCase().slice(1);
  kind = KIND[extension] || (extension ? extension.toUpperCase() : "File");
  debug(path, extension, kind);

  return kind;
}


// should return a lowercase, trimmed extension
// with common equivalents normalized e,g. jpeg -> jpg
function normalizeExtension (path) {
  let extension = extname(path).toLowerCase().slice(1);

  if (extension === "jpeg") {
    extension = "jpg";
  } 

  let res = {category: {}};

  res.category[Object.keys(CATEGORIES).find((category) => {
    return CATEGORIES[category].indexOf(extension) > -1;
  })] = true;

  res[extension] = true;

  return res;
}

function encodePath(input) {
  return input
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function resolveDisplayedEntry({ path, ownEntry, aggregatedEntry, multiInfo }) {
  if (ownEntry && !isDeleted(ownEntry) && !isMultiEntry(ownEntry, multiInfo)) {
    return ownEntry;
  }

  if (aggregatedEntry && !isDeleted(aggregatedEntry) && multiInfo) {
    const sourcePaths = sourcePathsForEntry(aggregatedEntry, multiInfo);
    const isFolder = path === multiInfo.folderPath;
    const isSource = sourcePaths.indexOf(path) !== -1;

    if (isFolder || isSource) return aggregatedEntry;
  }

  if (ownEntry && !isDeleted(ownEntry)) return ownEntry;

  return null;
}

function isDeleted(entry) {
  return !!(entry && entry.deleted);
}

function isMultiEntry(entry, multiInfo) {
  if (!entry || isDeleted(entry)) return false;

  if (sourcePathsFromHtml(entry.html).length > 0) return true;

  if (
    entry.metadata &&
    Array.isArray(entry.metadata._sourcePaths) &&
    entry.metadata._sourcePaths.length > 0
  ) {
    return true;
  }

  return !!(multiInfo && entry.path === multiInfo.entryPath);
}

function sourcePathsForEntry(entry, multiInfo) {
  const fromHtml = sourcePathsFromHtml(entry && entry.html);
  if (fromHtml.length) return fromHtml;

  const fromMetadata =
    entry &&
    entry.metadata &&
    Array.isArray(entry.metadata._sourcePaths)
      ? entry.metadata._sourcePaths.slice()
      : [];

  if (fromMetadata.length) return fromMetadata;

  if (multiInfo && multiInfo.folderPath) return [multiInfo.folderPath];

  return [];
}

function isFolderPostHtml(html) {
  return typeof html === "string" && html.indexOf('class="multi-file-post"') !== -1;
}

function sourcePathsFromHtml(html) {
  // Only treat this as a folder post if it carries the generated wrapper.
  // A normal post can legitimately contain a stray data-file attribute
  // (e.g. <pre data-file="example.js">) and must not be misclassified.
  if (!isFolderPostHtml(html)) return [];

  const paths = [];
  const pattern = /<section class="multi-file-entry"[^>]*\sdata-file="([^"]*)"/g;
  let match;

  while ((match = pattern.exec(html))) {
    paths.push(unescapeAttribute(match[1]));
  }

  return paths;
}

function unescapeAttribute(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function buildMultiEntryData({
  blogID,
  entry,
  folderDetails,
  sourcePaths,
  currentPath,
  timeZone,
}) {
  const folderPath = folderDetails ? folderDetails.folderPath : null;
  const entryPath = folderDetails ? folderDetails.entryPath : entry.path;

  const existence = await Promise.all(
    sourcePaths.map((sourcePath) => {
      return fs.pathExists(localPath(blogID, sourcePath)).catch(() => false);
    })
  );

  // The "Post files:" row shows each source file's relative path and size, so
  // stat each file that still exists.
  const stats = await Promise.all(
    sourcePaths.map((sourcePath, index) =>
      existence[index]
        ? Stat(localPath(blogID, sourcePath), timeZone).catch(() => null)
        : Promise.resolve(null)
    )
  );

  const sources = sourcePaths.map((sourcePath, index) => {
    return {
      path: sourcePath,
      name: basename(sourcePath),
      relativePath: folderPath
        ? relativeToFolder(folderPath, sourcePath)
        : basename(sourcePath),
      url: encodePath(sourcePath),
      index: index,
      displayIndex: index + 1,
      current: sourcePath === currentPath,
      exists: existence[index],
      hidden: index >= VISIBLE_SOURCE_LIMIT,
      size: stats[index] ? stats[index].size : null,
    };
  });

  const hiddenCount = sources.filter((source) => source.hidden).length;

  return {
    folderPath: folderPath,
    folderUrl: folderPath ? encodePath(folderPath) : null,
    entryPath: entryPath,
    entryUrl: entry.url,
    viewingSource: sources.some((source) => source.current),
    sources: sources,
    sourceCount: sources.length,
    hiddenCount: hiddenCount,
    truncated: hiddenCount > 0,
    hasMissing: sources.some((source) => !source.exists),
  };
}

// Path of a source file relative to its "+" folder, e.g. "sub/notes.md".
function relativeToFolder(folderPath, sourcePath) {
  const relative = path.relative(folderPath, sourcePath);
  return relative && !relative.startsWith("..") ? relative : basename(sourcePath);
}

function isSyntheticDependency (path) {
  return SYNTHETIC_DEPENDENCY_PREFIXES.some((prefix) => {
    return path.indexOf(prefix) === 0;
  });
}
