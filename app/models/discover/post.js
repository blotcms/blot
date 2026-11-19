const client = require("models/client");
const Entry = require("models/entry");
const ensure = require("helper/ensure");
const key = require("./key");
const postID = require("./postID");
const photos = require("./photos");

function deserialize(id, hash) {
  if (!hash || !hash.blogID || !hash.entryID) return null;

  let saved;

  try {
    saved = JSON.parse(hash.photos || "[]");
  } catch (err) {
    saved = [];
  }

  return {
    id,
    blogID: hash.blogID,
    entryID: hash.entryID,
    photos: Array.isArray(saved) ? saved : [],
    added: parseInt(hash.added, 10) || 0,
    // Whether the card shows the post's text above its photos
    showText: hash.showText === "1",
  };
}

// Resolves to the post, or null
async function get(id) {
  ensure(id, "string");
  return deserialize(id, await client.hGetAll(key.post(id)));
}

// Resolves to the posts that exist, in the order asked for
async function getMany(ids) {
  ensure(ids, "array");

  if (!ids.length) return [];

  const multi = client.multi();
  for (const id of ids) multi.hGetAll(key.post(id));
  const hashes = await multi.exec();

  return ids.map((id, i) => deserialize(id, hashes[i])).filter(Boolean);
}

async function has(blogID, entryID) {
  return !!(await client.exists(key.post(postID(blogID, entryID))));
}

// Adds a post, or replaces the photos of one already on Discover. photos are
// the derived ones, from photos.derive. The feed is in the order the posts
// were published, so the post's date is its score; a post without one goes
// by when it was added. options.showText shows the post's text above its photos; left out, it stays as it was.
// Resolves to the post.
async function add(blogID, entryID, saved, options = {}) {
  ensure(blogID, "string").and(entryID, "string").and(saved, "array");

  const id = postID(blogID, entryID);
  const existing = await get(id);
  const added = existing ? existing.added : Date.now();

  const entry = await Entry.get(blogID, entryID);
  const published =
    entry && entry.dateStamp > 0 ? Math.round(entry.dateStamp) : added;

  await client
    .multi()
    .hSet(key.post(id), {
      blogID,
      entryID,
      photos: JSON.stringify(saved),
      added: String(added),
      showText: (
        options.showText === undefined
          ? existing && existing.showText
          : options.showText
      )
        ? "1"
        : "0",
    })
    .zAdd(key.posts(), { score: published, value: id })
    .sAdd(key.blog(blogID), id)
    .exec();

  if (existing) {
    const kept = saved.map((photo) => photo.path);
    await photos.remove(
      blogID,
      existing.photos.filter((photo) => kept.indexOf(photo.path) === -1)
    );
  }

  return get(id);
}

// Shows or hides the post's text above its photos. Resolves to the post, or
// null when it isn't on Discover.
async function setShowText(id, show) {
  ensure(id, "string");
  if (!(await client.exists(key.post(id)))) return null;
  await client.hSet(key.post(id), "showText", show ? "1" : "0");
  return get(id);
}

// Removes a post and its derived photos. Resolves to true if it was there.
async function remove(id) {
  ensure(id, "string");

  const post = await get(id);

  await client.multi().zRem(key.posts(), id).del(key.post(id)).exec();

  if (!post) return false;

  await client.sRem(key.blog(post.blogID), id);
  await photos.remove(post.blogID, post.photos);

  return true;
}

// Removes every post of a blog. Resolves to how many there were.
async function removeBlog(blogID) {
  ensure(blogID, "string");

  const ids = await client.sMembers(key.blog(blogID));

  for (const id of ids) await remove(id);

  await client.del(key.blog(blogID));
  await require("./profile").remove(blogID);

  return ids.length;
}

module.exports = { get, getMany, has, add, setShowText, remove, removeBlog };
