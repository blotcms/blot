var rebuildDependents = require("./rebuildDependents");
var Ignore = require("./ignore");
var Entry = require("models/entry");
var Preview = require("./preview");
var isPreview = require("./drafts").isPreview;
var isDraft = require("./drafts").isDraft;
var WRONG_TYPE = "WRONG_TYPE";
var TOO_LARGE = "TOO_LARGE";
var PUBLIC_FILE = "PUBLIC_FILE";
var isHidden = require("build/prepare/isHidden");
var build = require("build");
var pathNormalizer = require("helper/pathNormalizer");
var makeSlug = require("helper/makeSlug");
var path = require("path");
var IgnoredFiles = require("models/ignoredFiles");
var folder = require("storage/folder");
var postSourceSize = require("build/converters/post-source-size");
var buildFlags = require("build/flags");
var storeBuildFlags = require("./storeBuildFlags");
var isUnsafeFolderPostPreview = require("./isUnsafeFolderPostPreview");
var folderPostSourceFolder = require("./folderPostSourceFolder");
var isRedisUnavailableError =
  require("helper/redisUnavailable").isRedisUnavailableError;

var basename = (path.posix || path).basename;

var noop = () => {};

function isPublic(path) {
  const normalizedPath = pathNormalizer(path).toLowerCase();
  return (
    // blot specific rule not to turn files inside
    // a folder called public into blog posts
    normalizedPath.startsWith("/public/") ||
    // blot specific rule to ignore files and folders
    // whose name begins with an underscore
    normalizedPath.includes("/_") ||
    // convention to ingore dotfiles or folders
    normalizedPath.includes("/.") ||
    // textbundle asset files
    normalizedPath.includes(".textbundle/assets/")
  );
}

function isTemplate(path) {
  return pathNormalizer(path).toLowerCase().startsWith("/templates/");
}

// Sets one source's flags on a file (models/file/flags.js). A failure is
// ignored, as a failed clear of the ignored record is: flags are a report,
// and must never fail a sync.
async function setFlags(blogID, sourcePath, source, list) {
  try {
    await folder.setFlags(blogID, sourcePath, source, list);
  } catch (err) {}
}

// Flags a post source over its size limit (models/file/flags.js), with its
// size and the limit. A failure is ignored, as the ignored record's is.
async function flagTooLarge(blogID, sourcePath) {
  try {
    var stat = await folder.stat(blogID, sourcePath);

    if (stat.isDirectory) return;

    await folder.setFlags(blogID, sourcePath, "build", [
      {
        code: "POST_TOO_LARGE",
        size: stat.size,
        limit: postSourceSize.limitForPath(sourcePath).bytes,
      },
    ]);
  } catch (err) {}
}

async function dropEntryAndPreview(blogID, targetPath) {
  targetPath = pathNormalizer(targetPath);

  var entry;

  try {
    entry = await Entry.get(blogID, targetPath);
  } catch (err) {
    // A failed read is not a missing entry: dropping nothing would lose the
    // deletion, so pass on a Redis outage.
    if (isRedisUnavailableError(err)) throw err;
    return;
  }

  if (!entry) return;

  var skipPreview = isUnsafeFolderPostPreview(targetPath, entry.html);

  await Entry.drop(blogID, targetPath);

  if (entry.draft && !isHidden(targetPath) && !skipPreview) {
    await Preview.remove(blogID, targetPath);
  }
}

// When a "+" folder can no longer build an aggregate (its files are gone,
// it was replaced by a file, ...), the previously published entry at the
// plus-stripped path is stale and should be dropped - but only when that
// entry really is this folder's aggregate. A plain "/post.md+" file must
// not unpublish an unrelated "/post.md" sibling. Throws finalErr, if there
// is one, unless it dropped the aggregate.
async function dropStaleAggregate(blog, multiInfo, finalErr) {
  if (multiInfo) {
    var existing;
    var getErr;

    try {
      existing = await Entry.get(blog.id, multiInfo.entryPath);
    } catch (err) {
      getErr = err;
    }

    if (!existing && getErr && isRedisUnavailableError(getErr)) throw getErr;

    var sourceFolder = folderPostSourceFolder(existing);
    if (
      sourceFolder &&
      pathNormalizer(sourceFolder) === pathNormalizer(multiInfo.folderPath)
    ) {
      return dropEntryAndPreview(blog.id, multiInfo.entryPath);
    }
  }

  if (finalErr) throw finalErr;
}

// state.unchanged is set when the build stored exactly the entry that was
// already there (see Entry.set's changed), so nothing derived from it differs
async function buildAndSet(blog, path, multiInfo, state) {
  var entry;

  // A placeholder's bytes aren't the file's (Blot couldn't fetch it), so it
  // is not a post: building it would publish an empty one
  if (!multiInfo && (await folder.isPlaceholder(blog.id, path))) {
    await IgnoredFiles.drop(blog.id, path).catch(noop);
    return dropEntryAndPreview(blog.id, path);
  }

  var found;

  try {
    ({ result: entry, flags: found } = await buildFlags.collect(() =>
      build(blog, path)
    ));
  } catch (err) {
    if (err && err.code === "WRONGTYPE") {
      await setFlags(blog.id, path, "build", []);
      await Ignore(blog.id, path, WRONG_TYPE);
      return dropStaleAggregate(blog, multiInfo);
    }

    if (err && err.code === TOO_LARGE) {
      // If this file was previously published as a draft, Preview.write
      // already dropped a companion .preview.html into the user's folder.
      // Mirror the cleanup in app/sync/update/drop.js so we don't leave an
      // orphaned preview behind now that the source can't become a post.
      var is_draft;

      try {
        is_draft = await isDraft(blog.id, path);
      } catch (draftErr) {}

      // Not waited for, and a failure is ignored
      if (is_draft) Preview.remove(blog.id, path).catch(noop);

      // An oversized source inside a "+" folder aborts the whole
      // aggregate build, so drop the now-stale synthesized entry too.
      await Ignore(blog.id, path, TOO_LARGE);
      // In a "+" folder the oversized source may not be the file that changed
      await flagTooLarge(blog.id, err.sourcePath || path);
      return dropStaleAggregate(blog, multiInfo);
    }

    // A "+" folder whose plus-stripped path is a real sibling file (e.g.
    // "/article.md+" beside "/article.md") is not aggregated - the file keeps
    // its own entry.
    if (err && err.code === "PLUS_PATH_COLLISION") return;

    // EMPTY / TOO_MANY_FILES only fire for a genuine directory, so an empty
    // folder is just "nothing to publish" - not an error to propagate.
    if (err && ["EMPTY", "TOO_MANY_FILES"].indexOf(err.code) !== -1)
      return dropStaleAggregate(blog, multiInfo);

    // ENOTDIR / ENOENT can also come from a plain "+"-suffixed file whose
    // stripped path is a valid sibling; keep the error unless we cleaned up a
    // real aggregate.
    if (err && ["ENOTDIR", "ENOENT"].indexOf(err.code) !== -1)
      return dropStaleAggregate(blog, multiInfo, err);

    // The file can't be published: say why on the file itself
    var failed = buildFlags.fromError(err);
    if (failed && !multiInfo) await setFlags(blog.id, path, "build", [failed]);

    throw err;
  }

  var sourcePaths = [];

  if (entry.metadata && Array.isArray(entry.metadata._sourcePaths)) {
    sourcePaths = entry.metadata._sourcePaths
      .map(pathNormalizer)
      .filter(Boolean);
  }

  var dropTargets = sourcePaths
    .filter(function (sourcePath) {
      return sourcePath !== entry.path;
    })
    .filter(function (value, index, array) {
      return array.indexOf(value) === index;
    });

  for (const target of dropTargets) {
    await dropEntryAndPreview(blog.id, target);
  }

  if (entry.metadata && entry.metadata._sourcePaths)
    delete entry.metadata._sourcePaths;

  var result = await Entry.set(blog.id, entry.path, entry);

  // Only a plain published entry: dropping other sources changed
  // something, and a draft rewrites its preview file
  state.unchanged =
    !!result && result.changed === false && !dropTargets.length && !entry.draft;

  // A successful rebuild means any previous "ignored" record for
  // this path (wrong type, too large, …) is stale. Errors are
  // swallowed so a failed clear can't fail the sync, but we wait
  // for it so callers never observe the stale record after the
  // sync finishes. For a folder post the same applies to each
  // source file that is now part of the aggregate again (e.g. one
  // shrunk back under the size limit), otherwise the dashboard
  // keeps hiding its badge.
  await Promise.all(
    [entry.path].concat(sourcePaths).map(function (ignoredPath) {
      return IgnoredFiles.drop(blog.id, ignoredPath).catch(noop);
    })
  );

  // Likewise the build's flags on each of them (models/file/flags.js). A
  // single file gets what this build found instead. A folder post's flags
  // have no one file to go on, so they are dropped for now.
  await Promise.all(
    [entry.path].concat(sourcePaths).map(function (sourcePath) {
      var own = !multiInfo && sourcePath === entry.path;

      return storeBuildFlags(blog.id, sourcePath, own ? found : []);
    })
  );

  const syntheticKeys = new Set();

  const slugToken = makeSlug(
    entry.slug || entry.metadata.title || entry.title || ""
  );
  if (slugToken) {
    syntheticKeys.add(`/__wikilink_slug__/${slugToken}`);
  }

  const filenameToken = entry.path ? basename(entry.path) : "";
  if (filenameToken) {
    syntheticKeys.add(`/__wikilink_filename__/${filenameToken}`);
  }

  // An unchanged entry has the same slug and file name, and
  // the same contentHash, so the same source bytes: what
  // depends on it would build the same
  if (!state.unchanged)
    syntheticKeys.forEach((syntheticKey) =>
      rebuildDependents(blog.id, syntheticKey).catch(noop)
    );

  // A draft folder post outside /drafts/ would write "/album.html"
  // and could clobber a real sibling source file, so skip the
  // filesystem preview there (still viewable via the draft URL).
  if (
    entry.draft &&
    !isHidden(entry.path) &&
    !isUnsafeFolderPostPreview(entry.path, entry.html)
  ) {
    await Preview.write(blog.id, entry.path);
  }
}

module.exports = async function set(blog, path) {
  // if typeof blog is not object, return error
  if (typeof blog !== "object") {
    throw new Error("sync.set: blog must be an object");
  }

  // if typeof path is not string, return error
  if (typeof path !== "string") {
    throw new Error("sync.set: path must be a string");
  }

  path = pathNormalizer(path);

  var multiInfo = build.findMultiFolder(path);
  var state = { unchanged: false };
  var ignoring = false;

  var is_preview = await isPreview(blog.id, path);

  if (isPublic(path)) {
    // The file is public. Its name begins
    // with an underscore, or it's inside a folder
    // whose name begins with an underscore. It should
    // therefore not be a blog post.
    ignoring = true;
    await Ignore(blog.id, path, PUBLIC_FILE);
  } else if (!isTemplate(path) && !is_preview) {
    // This file should become a blog post or page!
    await buildAndSet(blog, path, multiInfo, state);
  }

  // Resolves to { changed: false } when the file built exactly the
  // entry already stored, so the caller need not purge the blog's pages
  if (state.unchanged && !ignoring) return { changed: false };

  var targets = [path];

  if (multiInfo && multiInfo.entryPath)
    targets.push(pathNormalizer(multiInfo.entryPath));

  targets = targets.map(pathNormalizer).filter(function (value, index, array) {
    return array.indexOf(value) === index;
  });

  for (const target of targets) {
    await rebuildDependents(blog.id, target);
  }
};
