// Read-only: shows what Blot built for a test blog's entry and whether the
// generated assets it uses exist on disk and (once there is a bucket) in S3.
// Used by the test-blogs skill (.claude/skills/test-blogs/SKILL.md).
//
// Usage: node scripts/test-blogs/inspect.js <handle> [path-in-folder] [-n N]
//
// With a path (e.g. skilltest-1700000000/post.md) it inspects that entry; with
// none it inspects the N most recent entries (default 3). Prints one line per
// entry, thumbnail and asset. Nothing is written, rebuilt or created.

const Blog = require("models/blog");
const Entry = require("models/entry");
const Entries = require("models/entries");
const config = require("config");
const assets = require("storage/assets");

const SCOPES = [
  "_assets",
  "_image_cache",
  "_thumbnails",
  "_avatars",
  "_bookmark_screenshots",
];

const args = process.argv.slice(2);
let limit = 3;
const positional = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "-n") limit = parseInt(args[++i], 10) || limit;
  else positional.push(args[i]);
}

const [handle, folderPath] = positional;

if (!handle) {
  console.error(
    "Usage: node scripts/test-blogs/inspect.js <handle> [path-in-folder] [-n N]"
  );
  process.exit(1);
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decode(string) {
  try {
    return decodeURIComponent(string);
  } catch (e) {
    return string;
  }
}

// Tolerates the S3 backend not existing yet, or no bucket being configured.
function loadS3() {
  if (!(config.storage && config.storage.bucket)) return null;

  try {
    const s3 = require("storage/s3");
    return s3 && typeof s3.head === "function" ? s3 : null;
  } catch (e) {
    return null;
  }
}

function first(object, names) {
  for (const name of names) if (object[name] !== undefined) return object[name];
}

async function headS3(s3, key) {
  try {
    const head = await s3.head(key);
    if (!head) return "s3=missing";

    const size = first(head, ["size", "ContentLength"]);
    const type = first(head, ["contentType", "ContentType"]);
    const cache = first(head, ["cacheControl", "CacheControl"]);

    return (
      "s3=yes " +
      size +
      "B " +
      type +
      ' cache-control="' +
      (cache || "") +
      '"'
    );
  } catch (err) {
    const code = err && (err.code || err.name || err.status);

    if (/NotFound|NoSuchKey|ENOENT|404/.test(code)) return "s3=missing";

    return "s3=error(" + (err && err.message) + ")";
  }
}

// Relative paths (within the blog's asset directory) of every asset URL the
// entry's HTML and thumbnails refer to, in the order first seen.
function findAssets(blog, entry) {
  const found = new Map();
  let text = entry.html || "";
  const thumbnails = [];

  Object.keys(entry.thumbnail || {}).forEach(function (size) {
    const thumb = entry.thumbnail[size];
    if (thumb && thumb.url) {
      thumbnails.push({ size, url: thumb.url });
      text += "\n" + thumb.url;
    }
  });

  const cdn = new RegExp(
    escapeRegExp(config.cdn.origin) +
      "/" +
      escapeRegExp(blog.id) +
      "/([^\\s\"'<>)\\\\,?#]+)",
    "g"
  );

  // CDN URLs first, and removed from the text, so that the blog-domain
  // pattern below does not match their /_assets/... tails a second time.
  text = text.replace(cdn, function (match, relPath) {
    found.set(decode(relPath), "cdn");
    return " ";
  });

  const blogDomain = new RegExp(
    "/((?:" + SCOPES.join("|") + ")/[^\\s\"'<>)\\\\,?#]+)",
    "g"
  );

  let match;
  while ((match = blogDomain.exec(text))) {
    const relPath = decode(match[1]);
    if (!found.has(relPath)) found.set(relPath, "blog");
  }

  return { found, thumbnails };
}

function isoDate(ms) {
  return ms ? new Date(ms).toISOString() : "none";
}

async function inspectEntry(blog, entry, s3) {
  console.log(
    "entry " +
      entry.path +
      " url=" +
      entry.url +
      " updated=" +
      isoDate(entry.updated) +
      " deleted=" +
      !!entry.deleted +
      " draft=" +
      !!entry.draft
  );

  const { found, thumbnails } = findAssets(blog, entry);

  thumbnails.forEach(function (thumb) {
    console.log("  thumb " + thumb.size + " " + thumb.url);
  });

  if (!found.size) console.log("  (no assets in scope)");

  for (const [relPath, via] of found) {
    let disk;
    try {
      disk = (await assets.exists(blog.id, relPath)) ? "yes" : "missing";
    } catch (err) {
      disk = "error(" + err.message + ")";
    }

    const s3Part = s3 ? "  " + (await headS3(s3, blog.id + "/" + relPath)) : "";

    console.log("  asset via=" + via + " disk=" + disk + s3Part + "  " + relPath);
  }
}

function getBlog() {
  return new Promise(function (resolve, reject) {
    Blog.get({ handle }, function (err, blog) {
      if (err) return reject(err);
      if (!blog) return reject(new Error("No blog with handle " + handle));
      resolve(blog);
    });
  });
}

function getEntry(blogID, path) {
  return new Promise(function (resolve) {
    Entry.getByPath(blogID, path, resolve);
  });
}

function getRecent(blogID) {
  return new Promise(function (resolve) {
    Entries.getRecent(blogID, resolve);
  });
}

async function main() {
  const blog = await getBlog();
  const s3 = loadS3();

  console.log(
    "blog " +
      blog.id +
      " handle=" +
      blog.handle +
      " client=" +
      (blog.client || "none") +
      " s3=" +
      (s3 ? config.storage.bucket : "not configured")
  );

  let entries = [];

  if (folderPath) {
    const entry = await getEntry(
      blog.id,
      "/" + folderPath.replace(/^\/+/, "")
    );

    if (!entry) {
      console.log("entry " + folderPath + " not found");
      return;
    }

    entries = [entry];
  } else {
    // getRecent returns skinny entries; load each in full to get its HTML.
    const recent = (await getRecent(blog.id)).slice(0, limit);

    for (const skinny of recent) {
      const entry = await getEntry(blog.id, skinny.path || skinny.id);
      if (entry) entries.push(entry);
    }

    if (!entries.length) console.log("no entries");
  }

  for (const entry of entries) await inspectEntry(blog, entry, s3);
}

main()
  .then(function () {
    process.exit(0);
  })
  .catch(function (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  });
