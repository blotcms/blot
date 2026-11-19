const crypto = require("crypto");
const cheerio = require("cheerio");
const sharp = require("sharp");
const config = require("config");
const assets = require("storage/assets");
const ensure = require("helper/ensure");

// Photos on a card are at most this wide or tall
const SIZE = 1200;
const JPEG_QUALITY = 85;

// A card shows up to this many photos
const MAX_PHOTOS = 4;

// The confirm page offers no more than this many of a post's images
const MAX_CANDIDATES = 24;

// Discover's own derived photos, under each blog's assets. No sweep lists
// this directory (storage/sweep/references.js names the ones it does), and
// blog deletion removes it with the rest of the blog's assets.
const DIRECTORY = "_discover";

// A generated asset of the blog: _image_cache/<uuid>.jpg, _thumbnails/...
const ASSET_PATH = /^_[\w-]+\/[\w./-]+$/;

function prefix(blogID) {
  return config.cdn.origin + "/" + blogID + "/";
}

// The asset path of an image URL in a post, or null for an image which
// isn't one of the blog's generated assets on the CDN. Only those are
// offered: Discover reads them from the storage bucket, so it never fetches
// a URL from a post.
function sourceOf(blogID, src) {
  if (typeof src !== "string") return null;

  const start = prefix(blogID);

  if (src.indexOf(start) !== 0) return null;

  const rel = src.slice(start.length).split(/[?#]/)[0];

  if (!ASSET_PATH.test(rel) || rel.split("/").indexOf("..") !== -1) return null;

  if (rel.indexOf(DIRECTORY + "/") === 0) return null;

  return rel;
}

// The asset paths of the images in an entry's HTML, in order, without
// duplicates
function candidates(blogID, entry) {
  ensure(blogID, "string");

  const html = (entry && entry.html) || "";

  if (!html) return [];

  const $ = cheerio.load(html);
  const found = [];

  $("img").each(function () {
    const rel = sourceOf(blogID, $(this).attr("src"));
    if (rel && found.indexOf(rel) === -1) found.push(rel);
  });

  return found.slice(0, MAX_CANDIDATES);
}

function url(blogID, rel) {
  return assets.url(blogID, rel);
}

// Whether the entry still shows the image at the asset path
function stillInEntry(blogID, entry, source) {
  return !!(
    entry &&
    entry.html &&
    entry.html.indexOf(prefix(blogID) + source) !== -1
  );
}

// Resizes each source into the blog's _discover directory. Resolves to
// [{ source, path, width, height }] in the order given.
async function derive(blogID, postID, sources) {
  ensure(blogID, "string").and(postID, "string").and(sources, "array");

  const photos = [];

  for (const source of sources) {
    const input = await assets.read(blogID, source);

    const { data, info } = await sharp(input)
      .rotate()
      .resize({
        width: SIZE,
        height: SIZE,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer({ resolveWithObject: true });

    const name = crypto
      .createHash("sha1")
      .update(source)
      .digest("hex")
      .slice(0, 16);

    const path = DIRECTORY + "/" + postID + "/" + name + ".jpg";

    await assets.write(blogID, path, data);

    photos.push({ source, path, width: info.width, height: info.height });
  }

  return photos;
}

// Deletes derived photos. A photo already gone is fine.
async function remove(blogID, photos) {
  for (const photo of photos || []) {
    if (!photo || typeof photo.path !== "string") continue;
    if (photo.path.indexOf(DIRECTORY + "/") !== 0) continue;
    await assets.remove(blogID, photo.path);
  }
}

module.exports = {
  candidates,
  derive,
  remove,
  stillInEntry,
  url,
  MAX_PHOTOS,
  DIRECTORY,
};
