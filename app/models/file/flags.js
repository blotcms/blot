// The dictionary of file flags: what can go wrong with a file in a blog's
// folder that can't be worked out again from its path or the blog's
// settings. A flag is stored on the file's record (record.js) as
// { code, ...detail }, and goes when the file's bytes are replaced, so it
// never outlives what it describes. See README, "Flags".
//
// Each code has:
//   source       which writer sets it. A writer replaces all of its own
//                source's flags each time it runs and leaves the rest alone.
//   placeholder  the file in the folder is an empty stand-in for a file Blot
//                could not fetch. Its bytes are not the file's.
//   transient    a later attempt is likely to clear it on its own
//   message      what to tell the person, after the file's name
//   detail       the keys a flag of this code may carry beyond its code
//
// Readers ignore a code they don't know, so units on either side of a
// deploy can share records. Writers refuse one, which catches typos.

var SOURCES = ["sync", "upload", "build", "assets", "references", "links"];

var CODES = {
  // Getting the file into Blot's folder
  SYNC_TOO_LARGE: {
    source: "sync",
    placeholder: true,
    message: "is too large to sync",
    detail: ["size", "limit"],
  },
  SYNC_UNSUPPORTED: {
    source: "sync",
    placeholder: true,
    message: "is a kind of file that can't be downloaded",
    detail: ["kind"],
  },
  SYNC_EXPORT_TOO_LARGE: {
    source: "sync",
    placeholder: true,
    message: "is too large for Google to export",
    detail: [],
  },
  SYNC_RESTRICTED: {
    source: "sync",
    placeholder: true,
    message: "was refused by the service it syncs from",
    detail: ["error"],
  },
  SYNC_FAILED: {
    source: "sync",
    transient: true,
    message: "failed to sync",
    detail: ["error"],
  },
  SYNC_UNSAFE_PATH: {
    source: "sync",
    message: "has a name Blot can't store",
    detail: ["error"],
  },

  // Writing the file back out to the service it syncs from
  UPLOAD_FAILED: {
    source: "upload",
    transient: true,
    message: "failed to upload",
    detail: ["error"],
  },
  UPLOAD_TOO_LARGE: {
    source: "upload",
    message: "is too large to upload",
    detail: ["size", "limit"],
  },

  // Building the file into a post. Where the raw input can still be shown
  // (front matter, TeX, embeds), the build publishes it and only flags it.
  POST_TOO_LARGE: {
    source: "build",
    message: "is too large to publish as a post",
    detail: ["size", "limit"],
  },
  BUILD_TIMEOUT: {
    source: "build",
    message: "took too long to build",
    detail: ["step", "limit"],
  },
  BUILD_TOO_COMPLEX: {
    source: "build",
    message: "needed too much memory to build",
    detail: ["step"],
  },
  BUILD_FAILED: {
    source: "build",
    message: "failed to build",
    detail: ["step", "error"],
  },
  BUILD_DEFERRED: {
    source: "build",
    transient: true,
    message: "could not be built because Blot was busy",
    detail: ["step"],
  },
  FRONT_MATTER_INVALID: {
    source: "build",
    message: "has front matter which could not be read",
    detail: ["error", "line"],
  },
  DATE_INVALID: {
    source: "build",
    message: "has a date which could not be read",
    detail: ["value"],
  },
  MATH_FAILED: {
    source: "build",
    message: "has math which could not be rendered",
    detail: ["error", "targets"],
  },

  // Generated assets
  THUMBNAIL_TIMEOUT: {
    source: "assets",
    transient: true,
    message: "took too long to make a thumbnail",
    detail: ["target"],
  },
  THUMBNAIL_FAILED: {
    source: "assets",
    message: "has no image Blot could make a thumbnail from",
    detail: ["target", "error"],
  },
  IMAGE_OPTIMIZE_FAILED: {
    source: "assets",
    message: "has images which could not be resized",
    detail: ["targets"],
  },
  EMBED_FAILED: {
    source: "assets",
    transient: true,
    message: "has embeds which could not be loaded",
    detail: ["targets"],
  },
  SCREENSHOT_FAILED: {
    source: "assets",
    transient: true,
    message: "links to a page which could not be screenshotted",
    detail: ["target"],
  },

  // References in the file to other files and pages
  BROKEN_IMAGE: {
    source: "references",
    message: "shows images which are not in your folder",
    detail: ["targets"],
  },
  BROKEN_FILE_LINK: {
    source: "references",
    message: "links to files which are not in your folder",
    detail: ["targets"],
  },
  BROKEN_WIKILINK: {
    source: "references",
    message: "has wikilinks which don't match a post or file",
    detail: ["targets"],
  },
  REMOTE_IMAGE_FAILED: {
    source: "references",
    message: "shows images from other sites which could not be fetched",
    detail: ["targets"],
  },

  // Checked on a schedule, apart from the build
  BROKEN_EXTERNAL_LINK: {
    source: "links",
    message: "links to pages on other sites which could not be reached",
    detail: ["targets"],
  },
};

// Detail is capped so one file can't swell its directory's record
var MAX_TEXT = 200;
var MAX_TARGETS = 20;

function cap(value) {
  if (typeof value === "string")
    return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT - 1) + "…" : value;

  if (Array.isArray(value)) return value.slice(0, MAX_TARGETS).map(cap);

  if (value && typeof value === "object") {
    var result = {};
    for (var key in value) result[key] = cap(value[key]);
    return result;
  }

  return value;
}

// The flag to store: a known code and only the detail its code allows,
// capped. A list of targets longer than the cap keeps its full length in
// count.
function normalize(flag) {
  var definition = flag && CODES[flag.code];

  if (!definition) {
    throw new Error("models/file: unknown flag code " + (flag && flag.code));
  }

  var result = { code: flag.code };

  for (var key of definition.detail) {
    if (flag[key] === undefined || flag[key] === null) continue;

    result[key] = cap(flag[key]);

    if (Array.isArray(flag[key]) && flag[key].length > MAX_TARGETS)
      result.count = flag[key].length;
  }

  return result;
}

function sourceOf(code) {
  return CODES[code] ? CODES[code].source : null;
}

// existing with source's flags replaced by flags. Flags of other sources,
// and codes this unit doesn't know, are kept.
function replace(existing, source, flags) {
  if (SOURCES.indexOf(source) === -1) {
    throw new Error("models/file: unknown flag source " + source);
  }

  var kept = (existing || []).filter(function (flag) {
    return sourceOf(flag.code) !== source;
  });

  var added = (flags || []).map(function (flag) {
    var normalized = normalize(flag);

    if (sourceOf(normalized.code) !== source) {
      throw new Error(
        "models/file: flag " + normalized.code + " is not from " + source
      );
    }

    return normalized;
  });

  return kept.concat(added);
}

// Whether a record is an empty stand-in for a file Blot could not fetch
function isPlaceholder(record) {
  return !!(
    record &&
    record.flags &&
    record.flags.some(function (flag) {
      return CODES[flag.code] && CODES[flag.code].placeholder;
    })
  );
}

module.exports = {
  CODES,
  SOURCES,
  MAX_TEXT,
  MAX_TARGETS,
  normalize,
  sourceOf,
  replace,
  isPlaceholder,
};
