const crypto = require("crypto");
const sharp = require("sharp");
const config = require("config");
const client = require("models/client");
const assets = require("storage/assets");
const ensure = require("helper/ensure");
const key = require("./key");

// What Discover shows for a site in place of its blog's title, avatar and
// (for featured sites) its sites.txt details: a name, a short bio and an
// avatar, each optional, set by the maintainer for sites added by hand.
//
// The avatar is a square, resized copy in the blog's own assets, under
// _discover/profile/, served from the CDN. It comes from an uploaded file or
// from an image on Blot named by its URL (see readImage). Outside development
// nothing is fetched from a URL: anything else is uploaded.

const AVATAR_SIZE = 400;
const JPEG_QUALITY = 88;
const MAX_NAME = 100;
const MAX_BIO = 300;
const DIRECTORY = "_discover/profile";

// A blog's generated asset on the CDN: https://cdn.blot.im/<blogID>/_x/...
const CDN_ASSET = /^\/(blog_[a-f0-9]+)\/(_[\w-]+\/[^?#]+)$/;

function clean(value, max) {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

// Resolves to { name, bio, avatar (the CDN URL, or ""), avatarPath }, or
// null when the site has no profile
async function get(blogID) {
  ensure(blogID, "string");

  const hash = await client.hGetAll(key.profile(blogID));

  if (!hash || !Object.keys(hash).length) return null;

  return {
    name: hash.name || "",
    bio: hash.bio || "",
    avatarPath: hash.avatar || "",
    avatar: hash.avatar ? assets.url(blogID, hash.avatar) : "",
  };
}

// Resolves to a Map of blogID to profile, for the blogs which have one
async function getMany(blogIDs) {
  const profiles = new Map();

  for (const blogID of new Set(blogIDs)) {
    const profile = await get(blogID);
    if (profile) profiles.set(blogID, profile);
  }

  return profiles;
}

// Sets the name and bio. An empty one goes back to the site's own.
async function set(blogID, { name, bio }) {
  ensure(blogID, "string");

  const updates = {};
  const removed = [];

  for (const [field, value, max] of [
    ["name", name, MAX_NAME],
    ["bio", bio, MAX_BIO],
  ]) {
    if (value === undefined) continue;
    const cleaned = clean(value, max);
    if (cleaned) updates[field] = cleaned;
    else removed.push(field);
  }

  const multi = client.multi();
  if (Object.keys(updates).length) multi.hSet(key.profile(blogID), updates);
  if (removed.length) multi.hDel(key.profile(blogID), removed);
  await multi.exec();

  return get(blogID);
}

// Where a square crop is taken from an image which isn't square
const POSITIONS = ["centre", "top", "bottom", "left", "right"];

// Stores image data (a Buffer) as the site's avatar, replacing any before.
// Avatars are shown in a circle, so they are stored as a square: the crop is
// taken from options.position (centre, top, bottom, left or right).
async function setAvatarData(blogID, data, options = {}) {
  ensure(blogID, "string");

  const position = POSITIONS.includes(options.position)
    ? options.position
    : "centre";

  const resized = await sharp(data)
    .rotate()
    .resize({
      width: AVATAR_SIZE,
      height: AVATAR_SIZE,
      fit: "cover",
      position,
      withoutEnlargement: true,
    })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();

  const name = crypto.createHash("sha1").update(resized).digest("hex");
  const path = DIRECTORY + "/" + name.slice(0, 16) + ".jpg";
  const before = await client.hGet(key.profile(blogID), "avatar");

  await assets.write(blogID, path, resized);
  await client.hSet(key.profile(blogID), "avatar", path);

  if (before && before !== path) await assets.remove(blogID, before);

  return get(blogID);
}

// Resolves to the bytes of an image named by its URL, which must be on Blot:
//
// - a blog's generated asset on the CDN (https://cdn.blot.im/<blogID>/_x/...),
//   read from the storage bucket;
// - a file in a Blot site's folder, at the site's own address
//   (https://example.com/images/me.jpg), read from the site's folder.
//
// In development, where the bucket is local and won't have production's
// files, it is downloaded instead. Nothing else is fetched.
async function readImage(url) {
  let parsed;

  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error("Not a URL: " + url, { cause: err });
  }

  if (parsed.protocol !== "https:")
    throw new Error("The avatar URL must start with https://");

  let path;

  try {
    path = decodeURIComponent(parsed.pathname);
  } catch (err) {
    throw new Error("Not a URL: " + url, { cause: err });
  }

  if (path.split("/").includes("..")) throw new Error("Not a URL: " + url);

  try {
    if (
      parsed.origin === "https://cdn.blot.im" ||
      parsed.origin === config.cdn.origin
    ) {
      const match = CDN_ASSET.exec(path);
      if (!match) throw new Error("Not an image on the CDN: " + url);
      return await assets.read(match[1], match[2]);
    }

    const blogForHost = require("documentation/featured/blogForHost");
    const blog = await blogForHost(parsed.host);

    if (!blog) throw new Error("Not a Blot site: " + parsed.host);

    return await require("storage/folder").read(blog.id, path);
  } catch (err) {
    if (config.environment !== "development") throw err;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(15 * 1000),
    });
    if (!response.ok)
      throw new Error("HTTP " + response.status + " for " + url, {
        cause: err,
      });
    return Buffer.from(await response.arrayBuffer());
  }
}

// Stores the image at a URL on Blot (see readImage) as the site's avatar
async function setAvatarFromURL(blogID, url, options = {}) {
  ensure(blogID, "string").and(url, "string");
  return setAvatarData(blogID, await readImage(url), options);
}

// Takes the avatar off, back to the site's own
async function removeAvatar(blogID) {
  ensure(blogID, "string");

  const before = await client.hGet(key.profile(blogID), "avatar");
  await client.hDel(key.profile(blogID), "avatar");
  if (before) await assets.remove(blogID, before);

  return get(blogID);
}

// Removes the whole profile
async function remove(blogID) {
  ensure(blogID, "string");

  await removeAvatar(blogID);
  await client.del(key.profile(blogID));
}

module.exports = {
  get,
  getMany,
  set,
  setAvatarData,
  setAvatarFromURL,
  removeAvatar,
  remove,
  POSITIONS,
};
