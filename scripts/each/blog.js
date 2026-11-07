var User = require("models/user");
var Blog = require("models/blog");
var eachLimit = require("helper/eachLimit");
var type = require("helper/type");
var progress = require("./progress");

// Calls doThis(user, blog) for every blog with an owner. doThis may be async;
// a rejection stops the run.
async function eachBlog(doThis, options = {}) {
  // SMEMBERS order isn't stable, so sort to make -s/-e mean the same thing on every run.
  let blogIDs = await Blog.getAllIDs();

  if (!blogIDs) throw "No";

  blogIDs.sort();

  if (options.r) {
    console.log("Reversing the order of the blogs...");
    blogIDs = blogIDs.reverse();
  }

  if (options.s) {
    options.s = parseInt(options.s);
    console.log("Starting this script with blog which has ID", options.s);
    blogIDs = blogIDs.slice(options.s - 1);
  }

  if (options.e) {
    var end = parseInt(options.e);
    var start;

    if (options.s) {
      start = parseInt(options.s);
      end = end - start + 1;
      if (end < 1) end = undefined;
    }

    if (end) {
      console.log("Ending this script at user with ID", options.e);
      blogIDs = blogIDs.slice(0, end);
    } else {
      console.log("Warning: The end option was less than the start...");
    }
  }

  if (options.o) {
    // Unlike scripts/get/blog.js (and therefore eachBlogOrOneBlog.js), this
    // option does not resolve shortened IDs, handles, or domains. Callers
    // must provide complete blog IDs.
    if (type(options.o, "array")) {
      blogIDs = options.o.map(function (id) {
        return id + "";
      });
    } else {
      blogIDs = [options.o + ""];
    }

    console.log(
      "Starting this for blogs with ID",
      blogIDs.length > 1 ? blogIDs : blogIDs[0]
    );
  }

  var parallel = false;
  var limit = null;

  if (options.p) {
    parallel = true;
  } else if (options.c && parseInt(options.c, 10) > 1) {
    // Bounded concurrency: overlap the per-blog Redis reads without the
    // unbounded fan-out of options.p. The nested progress line (Blog x
    // Template x View) assumes one blog in flight at a time, so with
    // options.c it only tracks the blog frame reliably - acceptable for a
    // one-off migration where throughput matters more than a tidy status
    // line.
    limit = parseInt(options.c, 10);
    parallel = true;
  }

  // A concurrent run has several equally current blogs. In that case show
  // only aggregate completed progress rather than a misleading ID, ordinal,
  // or active-item percentage.
  var bar = progress.push("Blog", blogIDs.length, {
    percentage: !parallel,
  });
  var activeOrdinal = 0;

  // A failed Blog.get counts as no blog, and the next one carries on. A
  // failed User.getById stops the run.
  async function eachOne(blogID) {
    var blog;

    try {
      blog = await Blog.get({ id: blogID });
    } catch (err) {
      return;
    }

    if (!blog) return;

    var user = await User.getById(blog.owner);

    if (!user) return;

    await doThis(user, blog);
  }

  async function processBlog(blogID) {
    if (!parallel) {
      activeOrdinal += 1;
      // Set this before Blog.get so slow reads still identify the blog
      // currently being processed. Keep it separate from bar.tick(),
      // which counts only completed (including skipped) blogs.
      bar.setContext({
        detail: blogID.slice(0, 12),
        index: activeOrdinal,
      });
    }

    try {
      await eachOne(blogID);
    } finally {
      bar.tick();
    }
  }

  try {
    if (options.p) {
      await Promise.all(blogIDs.map((blogID) => processBlog(blogID)));
    } else if (limit) {
      await eachLimit(blogIDs, limit, (blogID) => processBlog(blogID));
    } else {
      for (const blogID of blogIDs) {
        await processBlog(blogID);
      }
    }
  } finally {
    bar.pop();
  }
}

module.exports = eachBlog;
module.exports.promise = eachBlog;
