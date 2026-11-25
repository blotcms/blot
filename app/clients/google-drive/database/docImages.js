// For each Google Doc fetched through the Docs API (util/fetchDoc.js), the
// images Blot already holds for it: { dir, images }, the Doc's _assets
// directory and inline object key -> file name in it. Also { built }: the
// revision and path last written *and built* into a post, set by the caller
// once the build has finished (setBuilt), so a fetch of that revision can
// skip the write. A write clears it, so a write whose build never finished
// (a deploy, a lost lock) is written and built again. A text edit finds
// every image here, so it makes no request to Google or to the bucket for
// images.
//
// One hash per blog, field = the Doc's Drive file id, so deleting the blog
// (its blog:<id>:* keys) or disconnecting Drive (../forget.js) removes it.
const client = require("models/client");
const refuseAfterAbort = require("./refuseAfterAbort");

const key = (blogID) => `blog:${blogID}:google-drive:doc-images`;

async function get(blogID, fileId) {
  const value = await client.hGet(key(blogID), fileId);
  if (!value) return {};
  try {
    return JSON.parse(value) || {};
  } catch (err) {
    return {};
  }
}

async function set(blogID, fileId, record) {
  if (!Object.keys(record.images || {}).length && !record.built)
    return client.hDel(key(blogID), fileId);
  await client.hSet(key(blogID), fileId, JSON.stringify(record));
}

// After the post for { revision, path } was built
async function setBuilt(blogID, fileId, built) {
  if (!built || !built.revision || !built.path || !built.sha1) return;
  const record = await get(blogID, fileId);
  await set(blogID, fileId, { ...record, built });
}

// What was built at this path ({ revision, path, sha1 }), if anything
async function getBuilt(blogID, fileId, path) {
  const { built } = await get(blogID, fileId);
  return built && built.path === path ? built : null;
}

async function drop(blogID) {
  await client.del(key(blogID));
}

module.exports = { get, set, setBuilt, getBuilt, drop, key };

// A fetch a disconnect cancelled can't bring back the record it just
// dropped (sync/seize.js)
refuseAfterAbort(module.exports, ["set", "setBuilt"]);
