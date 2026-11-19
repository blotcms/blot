// Exports the posts on Discover (#2639) so they can be imported on another
// copy of Blot, by scripts/discover/import.js. The maintainer curates Discover
// locally against mirrored copies of real sites, then imports the result on
// production.
//
//   node scripts/discover/export.js [file]
//
// Writes JSON to the file, or to stdout without one:
//
//   { version: 1, exported: <ms>, posts: [
//     { blogID, url, title, sources: ["_image_cache/..."], added: <ms> } ] }
//
// Posts are oldest first. A post is identified by its blog ID and the URL of
// its entry (like "/my-post"), not the entry's path, since the same post has
// a different path on another copy; each photo is identified by the asset
// path of the original image, not Discover's resized copy. A post whose
// entry is missing or has no URL is left out and reported on stderr.
//
// Only reads. Safe to rerun.

const fs = require("fs-extra");
const client = require("models/client");
const Entry = require("models/entry");
const Discover = require("models/discover");

function usage(message) {
  if (message) console.error(message + "\n");

  console.error("Usage: node scripts/discover/export.js [file]");
  process.exit(2);
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

  return { exported: { version: 1, exported: now, posts }, skipped };
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
    "Exported " + exported.posts.length + " posts, skipped " + skipped.length
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
