var eachBlogOrOneBlog = require("../each/eachBlogOrOneBlog");
var sync = require("../../app/sync");
var Entries = require("models/entries");

const processBlog = async (blog) => {
  if (
    !blog.plugins ||
    !blog.plugins.linkScreenshot ||
    !blog.plugins.linkScreenshot.enabled
  ) {
    console.log("No linkScreenshot plugin enabled for", blog.handle);
    return;
  }

  console.log("Starting sync for", blog.handle);

  return new Promise((resolve, reject) => {
    sync(blog.id, function (err, folder, done) {
      if (err) return reject(err);

      Entries.each(
        blog.id,
        function (entry, nextEntry) {
          if (!entry.id.endsWith(".webloc")) {
            console.log("Skipping", entry.id, "not a webloc file");
            return nextEntry();
          }

          if (entry.thumbnail.large) {
            console.log("Skipping", entry.id, "already has a thumbnail");
            return nextEntry();
          }

          console.log("Rebuilding", entry.id);
          folder.update(entry.id, function (err) {
            if (err) console.log(err);
            nextEntry();
          });
        },
        () =>
          done(null, (err) => {
            if (err) return reject(err);
            resolve();
          })
      );
    });
  });
};

if (require.main === module) {
  eachBlogOrOneBlog(processBlog)
    .then(() => {
      console.log("Done!");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Error:", err);
      process.exit(1);
    });
}
