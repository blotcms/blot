var eachBlogOrOneBlog = require("../each/eachBlogOrOneBlog");
var sync = require("../../app/sync");
var Entries = require("models/entries");
var Entry = require("models/entry");

function getEntry(blogID, id) {
  // A failed read is the same as no entry (as before)
  return Entry.get(blogID, id).catch(() => undefined);
}

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

  await sync(blog.id, async (folder) => {
    // Reading the entry list is not checked: a failure ended the entry loop
    // and still finished the sync, so it is ignored here too
    let ids = [];
    try {
      ids = await Entries.getAllIDs(blog.id);
    } catch (err) {}

    for (const id of ids) {
      const entry = await getEntry(blog.id, id);
      if (!entry) continue;

      if (!entry.id.endsWith(".webloc")) {
        console.log("Skipping", entry.id, "not a webloc file");
        continue;
      }

      if (entry.thumbnail.large) {
        console.log("Skipping", entry.id, "already has a thumbnail");
        continue;
      }

      console.log("Rebuilding", entry.id);
      try {
        await folder.update(entry.id);
      } catch (err) {
        if (err) console.log(err);
      }
    }
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
