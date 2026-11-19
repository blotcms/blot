var Entry = require("models/entry");
var Preview = require("./preview");
var isDraft = require("./drafts").isDraft;
var rebuildDependents = require("./rebuildDependents");
var builds = require("./builds");
var removeConvertedAssets = require("./removeConvertedAssets");

module.exports = async function drop(blogID, path) {
  // We don't know if this file used to be a draft based
  // on its metadata. We should probably look this up?
  // An error is ignored: the file is then treated as not a draft.
  var is_draft;

  try {
    is_draft = await isDraft(blogID, path);
  } catch (err) {}

  // Not waited for, and a failure is ignored
  if (is_draft) Preview.remove(blogID, path).catch(function () {});

  // ORDER IS IMPORTANT
  // Rebuild must happen after we remove the file from disk. In a
  // concurrent sync the drop waits for a rebuild of this path that is
  // still running, which would otherwise store it again (see builds.js).
  await builds.queue(blogID, path, function () {
    return Entry.drop(blogID, path);
  });
  await rebuildDependents(blogID, path);

  // Best effort: never fails the drop
  await removeConvertedAssets(blogID, path);
};
