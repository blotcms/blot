const eachBlog = require("./blog");
const getBlog = require("../get/blog");
const Blog = require("models/blog");
const getConfirmation = require("../util/getConfirmation");

/**
 * Processes either a single blog (if identifier provided) or all blogs (if no identifier).
 * 
 * @param {Function} processBlog - Async function that takes a blog object and processes it
 * @returns {Promise} Resolves when processing is complete
 */
module.exports = function eachBlogOrOneBlog(processBlog) {
  const identifier = process.argv[2];

  if (identifier) {
    // Process a single blog. getBlog owns identifier resolution, including
    // shortened IDs; in contrast, each/blog.js's -o option requires full IDs.
    return new Promise((resolve, reject) => {
      getBlog(identifier, (err, _user, blog) => {
        if (err || !blog) {
          return reject(new Error(`No blog: ${identifier}`));
        }

        processBlog(blog)
          .then(() => resolve())
          .catch((processErr) => reject(processErr));
      });
    });
  } else {
    // Process all blogs - first get count and ask for confirmation
    return new Promise((resolve, reject) => {
      Blog.getAllIDs(function (err, blogIDs) {
        if (err || !blogIDs) {
          return reject(err || new Error("No blogs found"));
        }

        const blogCount = blogIDs.length;
        console.log(`Found ${blogCount} blog${blogCount !== 1 ? "s" : ""} to process.`);

        // Ask for confirmation, then process
        getConfirmation(
          `Are you sure you want to process all ${blogCount} blog${blogCount !== 1 ? "s" : ""}?`
        )
          .then((confirmed) => {
            if (!confirmed) {
              console.log("Processing cancelled.");
              return reject(new Error("Processing cancelled by user"));
            }

            // Process all blogs
            // Wrap async function to ensure next() is always called
            eachBlog(
              function (_user, blog, next) {
                // Wrap in promise to handle both sync and async errors
                Promise.resolve()
                  .then(() => processBlog(blog))
                  .then(() => {
                    next();
                  })
                  .catch((err) => {
                    console.error(`Error processing blog ${blog.id}:`, err.message);
                    next();
                  });
              },
              (err) => {
                if (err) return reject(err);
                resolve();
              }
            );
          })
          .catch((confirmationErr) => {
            reject(confirmationErr);
          });
      });
    });
  }
};
