// docker exec -it blot-node-app-1 node scripts/dropbox/fix-entry-dates.js

const eachBlogOrOneBlog = require("../each/eachBlogOrOneBlog");
const Entries = require("models/entries");
const Entry = require("models/entry");

const getConfirmation = require("../util/getConfirmation");

// A failed read is the same as no entry (as before)
const getEntry = (blogID, id) => Entry.get(blogID, id).catch(() => undefined);

const processBlog = async (blog) => {
  if (!blog || blog.isDisabled) return;
  if (blog.client !== "dropbox") return;

  const blogID = blog.id;
  const ids = await Entries.getAllIDs(blogID);

  for (const id of ids) {
    if (id === id.toLowerCase()) {
      console.log("Skipping lowercase path", id);
      continue;
    }

    const entry = await getEntry(blogID, id);

    if (!entry) {
      console.log("Skipping missing entry", id);
      continue;
    }

    if (entry.deleted) {
      console.log("Skipping deleted", id);
      continue;
    }

    // Entry has a publish date older than within last 24 hours
    if (Date.now() - entry.dateStamp > 24 * 60 * 60 * 1000) {
      console.log("Skipping older entry", id);
      continue;
    }

    const deletedEntry = await getEntry(blogID, id.toLowerCase());

    if (!deletedEntry) {
      console.log("Skipping missing lowercase entry", id);
      continue;
    }

    if (deletedEntry.dateStamp === entry.dateStamp) {
      console.log("Skipping matching dateStamps", id);
      continue;
    }

    // update the date of the original entry to match the deleted
    // lowercase entry
    console.log("Updating entry", id, "to match", id.toLowerCase());
    console.log(
      "Current dateStamp:",
      entry.dateStamp,
      new Date(entry.dateStamp)
    );
    console.log(
      "Deleted dateStamp:",
      deletedEntry.dateStamp,
      new Date(deletedEntry.dateStamp)
    );

    const confirmation = await getConfirmation(
      `${blogID} update ${id} to match ${id.toLowerCase()}?`
    );

    if (!confirmation) {
      console.log("Skipping unconfirmed", id);
      continue;
    }

    await Entry.set(blogID, id, {
      dateStamp: deletedEntry.dateStamp,
      created: deletedEntry.created,
      updated: deletedEntry.updated,
    });
  }
};

if (require.main === module) {
  const identifier = process.argv[2];

  if (!identifier) {
    console.log("Blogs to process: (will prompt for confirmation)");
  }

  eachBlogOrOneBlog(processBlog)
    .then(() => {
      console.log("All blogs processed!");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Error:", err);
      process.exit(1);
    });
}

module.exports = processBlog;
