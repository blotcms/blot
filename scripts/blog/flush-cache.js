// docker exec -it blot-node-app-1 node scripts/blog/update-cache-id.js [blog-identifier]
// Flushes the cache for blogs
//
// If a blog identifier is provided (handle, domain, or ID), flushes cache only for that blog.
// Otherwise, iterates over all blogs in series and flushes cache for each.
//
// This script:
// 1. Iterates over all blogs in series (or flushes a single blog if identifier provided)
// 2. Calls flushCache directly for each blog
// 3. Reports progress and completion statistics

const eachBlogOrOneBlog = require("../each/eachBlogOrOneBlog");
const flushCache = require("models/blog/flushCache");
const { promisify } = require("util");

const flushCacheAsync = promisify(flushCache);

let totalBlogs = 0;
let flushedBlogs = 0;
let failedBlogs = 0;
const errors = [];

const processBlog = async (blog) => {
  totalBlogs++;

  try {
    await flushCacheAsync(blog.id);
    flushedBlogs++;

    if (totalBlogs % 100 === 0) {
      console.log(
        `Progress: ${totalBlogs} blogs processed, ${flushedBlogs} flushed...`
      );
    }

    console.log(
      `[ok] Flushed cache for blog ${blog.id} (${blog.handle || "no handle"})`
    );
  } catch (err) {
    console.error(
      `[FAIL] Failed to flush cache for blog ${blog.id} (${
        blog.handle || "no handle"
      }):`,
      err.message
    );
    failedBlogs++;
    errors.push({
      blogID: blog.id,
      handle: blog.handle,
      error: err.message,
    });
  }
};

if (require.main === module) {
  const identifier = process.argv[2];

  if (identifier) {
    console.log(`Flushing cache for blog: ${identifier}\n`);
  } else {
    console.log("Starting cache flush for all blogs...");
    console.log("Iterating over all blogs in series...\n");
  }

  eachBlogOrOneBlog(processBlog)
    .then(() => {
      if (!identifier) {
        console.log(`\n${"=".repeat(60)}`);
        console.log("Flush complete:");
        console.log(`  Total blogs processed: ${totalBlogs}`);
        console.log(`  Blogs flushed: ${flushedBlogs}`);
        console.log(`  Blogs failed: ${failedBlogs}`);

        if (errors.length > 0) {
          console.log("\nErrors:");
          errors.slice(0, 10).forEach((error) => {
            console.log(
              `  Blog ${error.blogID} (${error.handle || "no handle"}): ${
                error.error
              }`
            );
          });
          if (errors.length > 10) {
            console.log(`  ... and ${errors.length - 10} more errors`);
          }
        }

        if (failedBlogs > 0) {
          console.log("\n[WARN] Some flushes failed. Review errors above.");
        } else {
          console.log("\n[ok] All blogs flushed successfully!");
        }

        // wait for flush to clear
        console.log("waiting a few minutes...");
        return new Promise((resolve) => setTimeout(resolve, 5 * 60 * 1000));
      } else {
        // wait for flush to clear
        console.log("waiting");
        return new Promise((resolve) => setTimeout(resolve, 10000));
      }
    })
    .then(() => {
      if (identifier) {
        console.log("waited");
      } else {
        console.log("waited");
      }
      process.exit(failedBlogs > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error("Flush failed:", err);
      process.exit(1);
    });
}

module.exports = processBlog;
