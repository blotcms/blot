const each = require("../each/user");
const s3 = require("storage/s3");
const File = require("models/file");
const prettySize = require("helper/prettySize");

let rolling_total = 0;

// Bytes of a blog's generated assets in the storage bucket: its objects under
// the {blogID}/_*/ prefixes. The folder ({blogID}/folder/) and the git store
// ({blogID}/git/) are under {blogID}/ too and are not counted here; the
// folder's size comes from its index below, with no listing.
async function bucketBytes(blogID) {
  let total = 0;

  for await (const object of s3.listEntries(blogID + "/")) {
    if (!object.key.startsWith(blogID + "/_")) continue;
    total += object.size;
  }

  return total;
}

// Bytes of the files in a blog's folder, from the totals models/file keeps
async function folderBytes(blogID) {
  return (await File.totals(blogID)).bytes;
}

each(
  function (user, next) {
    if (!user) {
      console.log("No user found, exiting.");
      return next();
    }

    if (
      user.isDisabled ||
      (user.subscription && user.subscription.status === "unpaid")
    ) {
      (async function () {
        let user_total = 0;

        for (const blogID of user.blogs) {
          try {
            const static_space_used_in_bytes = await bucketBytes(blogID);
            const folder_space_used_in_bytes = await folderBytes(blogID);

            const total_kilo_bytes =
              (static_space_used_in_bytes + folder_space_used_in_bytes) / 1000;

            rolling_total += total_kilo_bytes;
            user_total += total_kilo_bytes;
          } catch (e) {
            console.log("error", e);
          }
        }

        console.log(prettySize(user_total), user.email, user.blogs.join(","));
      })().then(function () {
        next();
      }, next);

      return;
    }

    next();
  },
  function (err) {
    if (err) throw err;
    console.log("Done!");
    // convert rolling_total bytes to human readable size
    console.log("Total space to be deleted:", prettySize(rolling_total));
    process.exit();
  }
);
