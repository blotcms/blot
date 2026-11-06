var { promisify } = require("util");
var withCallback = require("helper/withCallback");
var Entry = require("models/entry");
var Ignored = require("models/ignoredFiles");
var Preview = require("./preview");
var isDraft = require("./drafts").isDraft;
var rebuildDependents = require("./rebuildDependents");

module.exports = withCallback(async function drop(blogID, path) {
  // We don't know if this file used to be a draft based
  // on its metadata. We should probably look this up?
  // An error is ignored: the file is then treated as not a draft.
  var is_draft;

  try {
    is_draft = await promisify(isDraft)(blogID, path);
  } catch (err) {}

  if (is_draft) Preview.remove(blogID, path);

  // ORDER IS IMPORTANT
  // Rebuild must happen after we remove the file from disk
  await promisify(Ignored.drop)(blogID, path);
  await promisify(Entry.drop)(blogID, path);
  await promisify(rebuildDependents)(blogID, path);
});
