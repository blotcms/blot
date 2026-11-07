var debug = require("debug")("blot:build");
var crypto = require("crypto");
var basename = require("path").basename;
var folder = require("storage/folder");
var isDraft = require("../sync/update/drafts").isDraft;
var BuildSingle = require("./single");
var BuildMultiple = require("./multiple");
var Prepare = require("./prepare");
var Thumbnail = require("./thumbnail");
var DateStamp = require("./prepare/dateStamp");
var Entry = require("models/entry");
var moment = require("moment");
var enabledConverters = require("./converters/enabled");
var pathNormalizer = require("helper/pathNormalizer");
var bakeHTML = require("./plugins/folderAssets").bakeHTML;

// Front matter can replace entry.body, teaser and teaserBody with markup the
// author wrote, after the plugins ran, so folderAssets never saw it. Bake it
// the same way and record the files it links to as dependencies, so the
// entry is rebuilt when they change.
async function bakeOverriddenMarkup(blog, entry) {
  var fields = Prepare.overriddenMarkupFields(entry.metadata);
  var dependencies = new Set(entry.dependencies);

  for (const field of fields) {
    const result = await bakeHTML(entry[field], {
      blogID: blog.id,
      handle: blog.handle,
      domain: blog.domain,
      path: entry.path,
    });

    entry[field] = result.html;
    result.dependencies.forEach(function (path) {
      dependencies.add(path);
    });
  }

  entry.dependencies = Array.from(dependencies);
}

// This file cannot become a blog post because it is not
// a type that Blot can process properly.
function isWrongType(blog, path) {
  var isWrong = true;

  enabledConverters(blog).forEach(function (converter) {
    if (converter.is(path)) isWrong = false;
  });

  return isWrong;
}

function findMultiFolder(path) {
  var normalized = pathNormalizer(path);
  if (!normalized || normalized === "/") return null;

  var segments = normalized.split("/").filter(Boolean);
  var multiIndex = -1;

  // Use the OUTERMOST "+" segment as the folder boundary. Stripping "+" from
  // every ancestor would let distinct trees collide - "/foo+/bar+" and
  // "/foo/bar+" would both resolve to "/foo/bar" and overwrite each other's
  // stored entry. A "+" folder nested inside another "+" folder is not an
  // independent post; its files are already skipped while walking the parent
  // (see collectConvertibleFiles in multiple.js).
  for (var i = 0; i < segments.length; i++) {
    if (segments[i].slice(-1) === "+") {
      multiIndex = i;
      break;
    }
  }

  if (multiIndex === -1) return null;

  var folderSegments = segments.slice(0, multiIndex + 1);
  var entrySegments = folderSegments.map(stripTrailingPlus);

  var folderPath = "/" + folderSegments.join("/");
  var entryPath = "/" + entrySegments.join("/");

  if (!entryPath || entryPath === "//") entryPath = "/";

  return {
    folderPath: folderPath,
    entryPath: entryPath,
    triggerPath: normalized,
  };
}

function stripTrailingPlus(segment) {
  if (!segment) return segment;
  return segment.replace(/\+$/, "");
}

// The SHA-1 of a file's bytes, streamed, so no local copy of it is needed
async function hashSource(blogID, sourcePath) {
  var hash = crypto.createHash("sha1");

  for await (var chunk of folder.createReadStream(blogID, sourcePath)) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

// Hashes an entry's source bytes so we can tell whether its content has
// actually changed, independent of the file's mtime (which providers reset
// on every reconnect/resync/upload). `sourcePaths` is one path for a plain
// entry, or the sorted list of files that make up a multi-file/folder post
// (see multiple.js, which stores this on metadata._sourcePaths). Resolves to
// the hash (or calls back with (null, hash)) on success. If any source can't
// be hashed (deleted mid-build, EMFILE, a provider swapping the file out
// underneath us, ...) it rejects (calls back with (err)) - the caller must not
// derive a contentHash from a partial result, since a consistent failure would
// otherwise produce the same placeholder digest on every build and
// permanently mask real changes.
async function hashEntrySource(blog, sourcePaths) {
  var hashes = await Promise.all(
    sourcePaths.map(function (sourcePath) {
      return hashSource(blog.id, sourcePath);
    })
  );

  var combined = sourcePaths
    .map(function (sourcePath, i) {
      return sourcePath + ":" + hashes[i];
    })
    .join("|");

  return crypto.createHash("sha1").update(combined).digest("hex");
}

async function build(blog, path) {
  debug("Build:", process.pid, "processing", path);

  var multiInfo = findMultiFolder(path);

  // findMultiFolder is a path-only check, so a plain file whose name ends in
  // "+" (e.g. /post.md+) matches too. Only treat it as a folder post when the
  // "+" segment is a real directory - otherwise it is just a file, and its
  // plus-stripped path (/post.md) may be a valid sibling we must not disturb.
  if (multiInfo) {
    var stat;

    try {
      stat = await folder.stat(blog.id, multiInfo.folderPath);
    } catch (statErr) {}

    return buildWith(blog, path, stat && stat.isDirectory ? multiInfo : null);
  }

  return buildWith(blog, path, null);
}

async function buildWith(blog, path, multiInfo) {
  var entryPath = multiInfo ? multiInfo.entryPath : path;
  var builder = multiInfo ? BuildMultiple : BuildSingle;
  var buildArgument = multiInfo ? multiInfo : entryPath;

  if (!multiInfo && isWrongType(blog, entryPath)) {
    var err = new Error("Path is wrong type to convert");
    err.code = "WRONGTYPE";
    throw err;
  }

  debug("Blog:", blog.id, entryPath, " checking if draft");
  var is_draft = await isDraft(blog.id, entryPath);

  debug("Blog:", blog.id, entryPath, " attempting to build html");
  var built = await builder(blog, buildArgument);

  var html = built[0];
  var metadata = built[1] || {};
  var stat = built[2] || {};
  var dependencies = built[3] || [];
  var extras = built[4] || {};

  debug("Blog:", blog.id, entryPath, " extracting thumbnail");
  var thumbnail;

  try {
    thumbnail = await Thumbnail(blog, entryPath, metadata, html);
  } catch (err) {
    // Could be lots of reasons (404?)
  }

  if (!thumbnail) thumbnail = {};

  // Used by DateStamp: if the metadata date has no time-of-day, and
  // the entry was first created by Blot on that same calendar day,
  // we reuse the entry's original creation time rather than midnight.
  // A brand new entry has no stored 'created' yet - Entry.set is
  // about to assign it Date.now() moments after this build finishes,
  // so use that same instant here rather than leaving it undefined.
  // Otherwise a post created *and* dated for today would never
  // benefit from this until some later, unrelated rebuild.
  // A failed read is the same as no entry
  var existingEntry = await Entry.get(blog.id, entryPath).catch(
    () => undefined
  );

  var previousCreated =
    existingEntry && typeof existingEntry.created === "number"
      ? existingEntry.created
      : Date.now();

  // A multi-file/folder post is built from several source files
  // (see multiple.js, which sets metadata._sourcePaths); everything
  // else is built from the one file at entryPath. Only trust
  // _sourcePaths when this really is a BuildMultiple build - for a
  // plain post, metadata comes straight from user-controlled front
  // matter, so a hand-written `_sourcePaths:` key must not be able
  // to redirect what gets hashed.
  var sourcePaths =
    multiInfo &&
    metadata &&
    Array.isArray(metadata._sourcePaths) &&
    metadata._sourcePaths.length
      ? metadata._sourcePaths
      : [entryPath];

  var contentHash, hashErr;

  try {
    contentHash = await hashEntrySource(blog, sourcePaths);
  } catch (e) {
    hashErr = e;
  }

  var mtimeUpdated =
    stat && stat.mtime ? moment.utc(stat.mtime).valueOf() : Date.now();

  // If any source couldn't be hashed, fall back to the pre-hash
  // behaviour entirely for this build: treat 'updated' as changed
  // (safe default) and keep whatever contentHash was already
  // stored rather than persisting a partial/placeholder digest -
  // storing one could make a later, genuinely unchanged build look
  // different, or worse, make repeated failures look identical to
  // each other and mask a real content change.
  var storedContentHash =
    existingEntry && typeof existingEntry.contentHash === "string"
      ? existingEntry.contentHash
      : "";

  if (hashErr) {
    debug(
      "Blog:",
      blog.id,
      entryPath,
      " failed to hash source, treating as changed:",
      hashErr
    );
    contentHash = storedContentHash;
  }

  // Only move 'updated' when the source content itself has
  // changed. A provider reconnect/resync (or the eventual S3
  // migration, where Last-Modified is the upload time) rewrites
  // every file's mtime without changing its bytes, and that alone
  // shouldn't bump 'updated' or the sitemap's <lastmod>. Entries
  // built before this change have no stored contentHash, so they
  // take the mtime this once and get a hash stored for next time.
  var contentUnchanged =
    !hashErr &&
    existingEntry &&
    storedContentHash &&
    storedContentHash === contentHash &&
    typeof existingEntry.updated === "number";

  var entry;

  // Given the properties above
  // that we've extracted from the
  // local file, compute stuff like
  // the teaser, isDraft etc..

  entry = {
    html: html,
    name: basename(entryPath),
    path: entryPath,
    id: entryPath,
    thumbnail: thumbnail,
    draft: is_draft,
    metadata: metadata,
    size: typeof stat.size === "number" ? stat.size : 0,
    dependencies: dependencies,
    exif: (extras && extras.exif) || {},
    dateStamp: DateStamp(blog, entryPath, metadata, previousCreated),
    contentHash: contentHash,
    updated: contentUnchanged ? existingEntry.updated : mtimeUpdated,
  };

  if (entry.dateStamp === undefined) {
    entry.dateStampWasRemoved = true;
    delete entry.dateStamp;
  }

  debug(
    "Blog:",
    blog.id,
    entryPath,
    " preparing additional properties for",
    entry.name
  );
  entry = Prepare(entry, {
    titlecase: blog.plugins.titlecase.enabled,
    blogID: blog.id,
  });
  debug("Blog:", blog.id, path, " additional properties computed.");

  await bakeOverriddenMarkup(blog, entry);

  return entry;
}

const promiseOnly = require("helper/promiseOnly");

module.exports = promiseOnly(build);
module.exports.hashEntrySource = promiseOnly(hashEntrySource);
module.exports.findMultiFolder = findMultiFolder;
