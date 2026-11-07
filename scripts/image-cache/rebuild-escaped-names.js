// Finds blogs whose image cache has files named after a still percent-encoded
// slug (e.g. _image_cache/{uuid}/%E8%AF%B4%E6%98%8E.png). Their URLs were
// built without escaping, so the CDN decodes them and 404s. With --apply, each
// such blog is rebuilt under its sync lock with its image cache and thumbnails
// wiped, as the dashboard's "rebuild" with imageCache=true does. A plain
// rebuild is not enough: the image cache is keyed by the image's contents, so
// it would hand back the old, broken URLs.
//
// Usage:
//   node scripts/image-cache/rebuild-escaped-names.js [blog-identifier] [--apply]
//
// Without --apply it only lists the affected blogs and how many files each has.

const assets = require("storage/assets");
const Sync = require("sync");
const Rebuild = require("sync/rebuild");
const eachBlogOrOneBlog = require("../each/eachBlogOrOneBlog");

const APPLY = process.argv.indexOf("--apply") > -1;

// eachBlogOrOneBlog reads the blog identifier from process.argv[2]
process.argv = process.argv.filter((arg) => arg !== "--apply");

const affected = [];

async function countEscapedNames(blogID) {
  let count = 0;

  for await (const rel of assets.walk(blogID)) {
    if (rel.indexOf("_image_cache/") === 0 && rel.indexOf("%") > -1) count++;
  }

  return count;
}

// The rebuild's error is reported once the sync is released, or else the
// error releasing it
async function rebuild(blogID) {
  await Sync(blogID, async (folder) => {
    await Rebuild(blogID, {
      thumbnails: true,
      imageCache: true,
      status: folder.status,
      log: folder.log,
    });
  });
}

async function processBlog(blog) {
  const count = await countEscapedNames(blog.id);

  if (!count) return;

  affected.push(blog.id);
  console.log(
    blog.id,
    blog.handle,
    count,
    "image cache file(s) with escaped names"
  );

  if (!APPLY) return;

  try {
    await rebuild(blog.id);
    console.log(blog.id, "rebuilt");
  } catch (err) {
    console.log(blog.id, "rebuild failed:", err.message);
  }
}

if (require.main === module) {
  eachBlogOrOneBlog(processBlog)
    .then(() => {
      console.log(
        affected.length,
        "affected blog(s)",
        APPLY ? "processed" : "found (dry run, pass --apply to rebuild them)"
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
