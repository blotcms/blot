const each = require("../each/user");
const child_process = require("child_process");
const { blog_folder_dir } = require("config");
const s3 = require("storage/s3");
const prettySize = require("helper/prettySize");
const fs = require("fs");

let rolling_total = 0;

// Bytes of a blog's generated assets, summed over its objects in the assets
// bucket
async function assetBytes(blogID) {
  let total = 0;

  for await (const object of s3.listEntries(blogID + "/")) {
    total += object.size;
  }

  return total;
}

function folderBytes(blogID) {
  if (!fs.existsSync(`${blog_folder_dir}/${blogID}`)) return 0;

  const folder_space_used = child_process
    .execSync(`du -sb ${blog_folder_dir}/${blogID}`)
    .toString();

  return parseInt(folder_space_used.trim().split("\t")[0]);
}

each(
  function (user, next) {
    if (!user) {
      console.log("No user found, exiting.");
      return next();
    }

    if (
      user.isDisabled ||  (user.subscription && user.subscription.status === "unpaid")) {

      (async function () {
        let user_total = 0;

        for (const blogID of user.blogs) {
          try {
            const static_space_used_in_bytes = await assetBytes(blogID);
            const folder_space_used_in_bytes = folderBytes(blogID);

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
