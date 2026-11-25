// For each Google Doc fetched through the Docs API (util/fetchDoc.js), the
// images Blot already holds for it: { dir, images }, the Doc's _assets
// directory and inline object key -> file name in it. A text edit finds
// every image here, so it makes no request to Google or to the bucket for
// images.
//
// One hash per blog, field = the Doc's Drive file id, so deleting the blog
// (its blog:<id>:* keys) or disconnecting Drive (../forget.js) removes it.
const client = require("models/client");

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
  if (!Object.keys(record.images || {}).length)
    return client.hDel(key(blogID), fileId);
  await client.hSet(key(blogID), fileId, JSON.stringify(record));
}

async function drop(blogID) {
  await client.del(key(blogID));
}

module.exports = { get, set, drop, key };
