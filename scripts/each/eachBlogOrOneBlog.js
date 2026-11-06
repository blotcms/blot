const eachBlog = require("./blog");
const getBlog = require("../get/blog");
const Blog = require("models/blog");
const getConfirmation = require("../util/getConfirmation");

/**
 * Processes either a single blog (if identifier provided) or all blogs (if no identifier).
 *
 * @param {Function} processBlog - Async function that takes a blog object and processes it
 * @param {Object} [options]
 * @param {boolean} [options.confirm=true] - Ask before processing all blogs. Pass
 *   false for scripts that must run unattended.
 * @returns {Promise} Resolves when processing is complete
 */
module.exports = async function eachBlogOrOneBlog(processBlog, options = {}) {
  const identifier = process.argv[2];

  if (identifier) {
    // Process a single blog. getBlog owns identifier resolution, including
    // shortened IDs; in contrast, each/blog.js's -o option requires full IDs.
    const blog = await new Promise((resolve) => {
      getBlog(identifier, (err, _user, found) =>
        resolve(err ? undefined : found)
      );
    });

    if (!blog) throw new Error(`No blog: ${identifier}`);

    await processBlog(blog);
    return;
  }

  // Process all blogs - first get count and ask for confirmation
  const blogIDs = await Blog.getAllIDs();

  if (!blogIDs) throw new Error("No blogs found");

  const blogCount = blogIDs.length;
  console.log(
    `Found ${blogCount} blog${blogCount !== 1 ? "s" : ""} to process.`
  );

  const confirmed =
    options.confirm === false
      ? true
      : await getConfirmation(
          `Are you sure you want to process all ${blogCount} blog${blogCount !== 1 ? "s" : ""}?`
        );

  if (!confirmed) {
    console.log("Processing cancelled.");
    throw new Error("Processing cancelled by user");
  }

  // A blog whose processing fails is logged, and the next one carries on.
  await eachBlog.promise(async (_user, blog) => {
    try {
      await processBlog(blog);
    } catch (err) {
      console.error(`Error processing blog ${blog.id}:`, err.message);
    }
  });
};
