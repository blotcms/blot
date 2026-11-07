var _ = require("lodash");
var key = require("./key");
var client = require("models/client");
var getMetadata = require("./getMetadata");
var serialize = require("./util/serialize");
var metadataModel = require("./metadataModel");
var ensure = require("helper/ensure");
var injectLocals = require("./injectLocals");
var updateCdnManifest = require("./util/updateCdnManifest");
var cacheID = require("./util/cacheID");
var serializeRedisHashValues = require("models/redisHashSerializer");

module.exports = async function setMetadata(id, updates) {
  ensure(id, "string").and(updates, "object");

  var metadata;

  try {
    metadata = await getMetadata(id);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  var changes;
  metadata = metadata || {};

  // By value: readFromFolder passes a fresh errors object on every sync,
  // which by identity would always count as a change and purge the blog
  for (var i in updates) {
    if (!_.isEqual(metadata[i], updates[i])) changes = true;
    metadata[i] = updates[i];
  }

  metadata.cdn = metadata.cdn || {};

  if (!metadata.owner)
    throw new Error("No owner: please specify an owner for this template");

  try {
    injectLocals(metadata.locals);
  } catch (e) {
    console.log("error injecting locals:", e);
  }

  var owner = metadata.owner;

  // Never write back the cacheID read above: a setView between that read
  // and this write may have replaced it, and restoring the old one would
  // let renders reuse views cached before that save (see util/cacheID).
  delete metadata.cacheID;
  if (changes) metadata.cacheID = cacheID.create();

  metadata = serializeRedisHashValues(serialize(metadata, metadataModel));

  await client.sAdd(key.blogTemplates(owner), id);
  await client.hSet(key.metadata(id), metadata);

  if (changes) await cacheID.bumpBlogIfInstalled(owner, id);

  await updateCdnManifest(id);

  return changes;
};
