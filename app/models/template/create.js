var clone = require("./clone");
var promiseOnly = require("helper/promiseOnly");
var ensure = require("helper/ensure");
var makeSlug = require("helper/makeSlug");
var makeID = require("./util/makeID");
var client = require("models/client");
var key = require("./key");
var metadataModel = require("./metadataModel");
var setMetadata = require("./setMetadata");

// Associates a theme with a UID owner
// and an existing theme to clone if possible
module.exports = promiseOnly(async function create(owner, name, metadata) {
  ensure(owner, "string").and(metadata, "object").and(name, "string");

  name = name.slice(0, 100);
  metadata.slug = metadata.slug || makeSlug(name).slice(0, 30);
  metadata.slug = metadata.slug.split("/").join("-");
  metadata.id = makeID(owner, name);

  // A template is resolved by its id everywhere: routing, writeToFolder (which
  // names the on-disk directory after the stored slug) and readFromFolder
  // (which turns that name back into an id with makeID). A caller-supplied slug
  // — duplication, forking, adding a shared template — can be truncated
  // differently from the id when the name is long, and a stored slug that
  // makeID maps elsewhere lets a locally edited template be read back from its
  // folder as another template and overwrite it. Keep the slug in step with
  // the id; one that already round-trips (a local template named after its
  // folder) is left untouched, anything else falls back to the id's own suffix.
  if (makeID(owner, metadata.slug) !== metadata.id) {
    metadata.slug = metadata.id.split(":").slice(1).join(":");
  }

  metadata.name = name;
  metadata.owner = owner;
  metadata.locals = metadata.locals || {};
  metadata.cdn = metadata.cdn || {};
  metadata.description = metadata.description || "";
  metadata.thumb = metadata.thumb || "";
  metadata.localEditing = metadata.localEditing === true;
  metadata.previewPath = "/";
  metadata.shareID = "";

  ensure(metadata, metadataModel);

  var id = metadata.id;

  var stat = await client.exists(key.metadata(id));

  if (stat) {
    var err = new Error("A template called " + name + " name already exists");
    err.code = "EEXISTS";
    throw err;
  }

  await client.sAdd(key.blogTemplates(owner), id);
  await setMetadata(id, metadata);

  if (metadata.cloneFrom) await clone(metadata.cloneFrom, id, metadata);

  return metadata;
});
