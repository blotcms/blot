var Entry = require("models/entry");
var Preview = require("./preview");
var isDraft = require("./drafts").isDraft;
var dependents = require("./dependents");
var removeConvertedAssets = require("./removeConvertedAssets");

// track is the sync's dependents tracker (./dependents.js)
module.exports = async function drop(blogID, path, track) {
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
  // Rebuild must happen after we remove the file from disk
  await Entry.drop(blogID, path);
  // What linked to the file is rebuilt once, when the sync ends
  await dependents.record(blogID, path, [path], track);

  // Best effort: never fails the drop
  await removeConvertedAssets(blogID, path);
};
