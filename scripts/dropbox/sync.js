var resetToBlot = require("clients/dropbox/sync/reset-to-blot");
var eachBlogOrOneBlog = require("../each/eachBlogOrOneBlog");
console.warn("Warning: this uses an internal method of the Dropbox client.");
console.log('Consider debugging with "export DEBUG=clients:dropbox*"');
var fixEntryDates = require("./fix-entry-dates");

function runFullSync(blog) {
  return new Promise((resolve, reject) => {
    var publish = function () {
      var args = Array.prototype.slice.call(arguments);
      console.log.apply(
        console,
        ["Dropbox sync", blog.title, blog.id + ":"].concat(args)
      );
    };

    resetToBlot(blog.id, publish).then(
      function () {
        resolve();
      },
      function (err) {
        reject(err);
      }
    );
  });
}

let processedCount = 0;

const processBlog = async (blog) => {
  if (!blog || blog.isDisabled) return;
  if (blog.client !== "dropbox") return;

  processedCount++;

  console.log(
    processedCount + " blogs",
    "- Syncing",
    blog.title,
    blog.id,
    new Date(blog.cacheID)
  );

  try {
    await runFullSync(blog);
  } catch (err) {
    console.error(
      "Error syncing blog",
      blog.title,
      blog.id,
      "-",
      err.message || err
    );
    return;
  }

  try {
    await fixEntryDates(blog);
  } catch (fixErr) {
    console.error(
      "Error fixing entry dates for blog",
      blog.title,
      blog.id,
      "-",
      fixErr.message || fixErr
    );
  }
};

if (require.main === module) {
  eachBlogOrOneBlog(processBlog)
    .then(() => {
      console.log("Done!");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Sync finished with error", err.message || err);
      process.exit(1);
    });
}
