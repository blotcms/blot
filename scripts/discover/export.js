// Exports the posts on Discover (#2639) so they can be imported on another
// copy of Blot, by scripts/discover/import.js. The maintainer curates Discover
// locally against mirrored copies of real sites, then imports the result on
// production.
//
//   node scripts/discover/export.js [file]
//
// Writes JSON to the file, or to stdout without one:
//
//   { version: 1, exported: <ms>,
//     posts: [
//       { blogID, url, title, sources: ["_image_cache/..."], added: <ms> } ],
//     profiles: [
//       { blogID, host, name, bio, avatar: <base64 JPEG, or ""> } ] }
//
// Posts are oldest first. A post is identified by its blog ID and the URL of
// its entry (like "/my-post"), not the entry's path, since the same post has
// a different path on another copy; each photo is identified by the asset
// path of the original image, not Discover's resized copy. A post whose
// entry is missing or has no URL is left out and reported on stderr.
//
// Profiles (the name, bio and avatar the maintainer sets for a site, see
// app/models/discover/profile.js) are found by scanning Redis for
// discover:profile:* hashes rather than from the posts, since a site can have
// a profile before it has a post. The avatar travels in the file as base64,
// because it is stored in the blog's own assets, which the other copy doesn't
// have. host is for reading the file only; import goes by blogID.
//
// Only reads. Safe to rerun.

const fs = require("fs-extra");
const config = require("config");
const client = require("models/client");
const Entry = require("models/entry");
const Blog = require("models/blog");
const assets = require("storage/assets");
const Discover = require("models/discover");

function usage(message) {
  if (message) console.error(message + "\n");

  console.error("Usage: node scripts/discover/export.js [file]");
  process.exit(2);
}

// Resolves to the blog IDs which have a profile, sorted
async function profileBlogIDs() {
  const prefix = Discover.key.profile("");
  const keys = new Set(); // SCAN can return a key more than once
  let cursor = "0";

  do {
    const reply = await client.scan(cursor, {
      MATCH: prefix + "*",
      TYPE: "hash",
      COUNT: 1000,
    });
    cursor = String(reply.cursor);
    reply.keys.forEach((name) => keys.add(name));
  } while (cursor !== "0");

  return Array.from(keys)
    .map((name) => name.slice(prefix.length))
    .sort();
}

// The site's address, for reading the file: its domain or its blot.im host
function hostOf(blog) {
  if (!blog) return "";
  if (blog.domain) return blog.domain;
  return blog.handle ? blog.handle + "." + config.host : "";
}

// Resolves to the profiles of every blog which has one
async function exportProfiles() {
  const profiles = [];

  for (const blogID of await profileBlogIDs()) {
    const profile = await Discover.profile.get(blogID);

    if (!profile) continue;

    const avatar = profile.avatarPath
      ? (await assets.read(blogID, profile.avatarPath)).toString("base64")
      : "";

    profiles.push({
      blogID,
      host: hostOf(await Blog.get({ id: blogID })),
      name: profile.name,
      bio: profile.bio,
      avatar,
    });
  }

  return profiles;
}

// Resolves to { exported, posts, skipped } where skipped lists
// { id, blogID, entryID, reason } for each post left out
async function exportPosts(now = Date.now()) {
  const ids = await client.zRange(Discover.key.posts(), 0, -1);
  const posts = [];
  const skipped = [];

  for (const id of ids) {
    const post = await Discover.get(id);

    if (!post) {
      skipped.push({ id, reason: "no post stored" });
      continue;
    }

    const entry = await Entry.get(post.blogID, post.entryID);
    const reason = !entry
      ? "entry is missing"
      : !entry.url
        ? "entry has no url"
        : null;

    if (reason) {
      skipped.push({
        id,
        blogID: post.blogID,
        entryID: post.entryID,
        reason,
      });
      continue;
    }

    posts.push({
      blogID: post.blogID,
      url: entry.url,
      title: entry.title || "",
      sources: post.photos.map((photo) => photo.source),
      added: post.added,
    });
  }

  const profiles = await exportProfiles();

  return { exported: { version: 1, exported: now, posts, profiles }, skipped };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length > 1 || args.some((arg) => arg.startsWith("--")))
    usage("Unexpected arguments");

  const { exported, skipped } = await exportPosts();
  const json = JSON.stringify(exported, null, 2) + "\n";

  if (args[0]) await fs.outputFile(args[0], json);
  else process.stdout.write(json);

  for (const item of skipped)
    console.error(
      "Skipped " +
        (item.blogID ? item.blogID + " " + item.entryID : item.id) +
        ": " +
        item.reason
    );

  console.error(
    "Exported " +
      exported.posts.length +
      " posts and " +
      exported.profiles.length +
      " profiles, skipped " +
      skipped.length
  );
}

if (require.main === module) {
  main().then(
    function () {
      process.exit(0);
    },
    function (err) {
      console.error(err);
      process.exit(1);
    }
  );
}

module.exports = { exportPosts };
