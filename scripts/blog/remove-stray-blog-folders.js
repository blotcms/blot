var Blog = require("models/blog");
var fs = require("fs-extra");
var BLOGS_DIRECTORY = require("config").blog_folder_dir;
var s3 = require("storage/s3");

var tmp = require("helper/tempDir")();
var async = require("async");
var getConfirmation = require("../util/getConfirmation");
var colors = require("colors/safe");

if (require.main === module)
  main(function (err) {
    if (err) throw err;
    process.exit();
  });

// The blog IDs which have objects in the assets bucket, i.e. its top-level
// "folders" (blog_*/). Reported only, never moved or deleted.
async function listAssetPrefixes() {
  const blogIDs = [];

  for await (const entry of s3.listEntries("", "/")) {
    if (entry.prefix) blogIDs.push(entry.prefix.replace(/\/$/, ""));
  }

  return blogIDs;
}

function main(callback) {
  Blog.getAllIDs(function (err, ids) {
    if (err) return callback(err);

    const blogs_directory_contents = fs.readdirSync(BLOGS_DIRECTORY);

    const strayFolders = [];

    blogs_directory_contents.forEach((folder) => {
      if (folder.endsWith(".lock")) return;

      if (!ids.includes(folder))
        strayFolders.push({
          from: BLOGS_DIRECTORY + "/" + folder,
          to: tmp + folder,
        });
    });

    console.log(
      `There are ${strayFolders.length} folders without a corresponding blog in the db`
    );

    console.log(strayFolders);

    listAssetPrefixes().then(function (prefixes) {
      const strayAssets = prefixes.filter((blogID) => !ids.includes(blogID));

      console.log(
        `There are ${strayAssets.length} blogs with assets in the bucket but no ` +
          "corresponding blog in the db (reported only, not moved):"
      );
      console.log(strayAssets);

      async.eachSeries(
        strayFolders,
        function ({ from, to }, next) {
          getConfirmation(
            "Move?" + colors.dim("\nFrom: " + from + "\n. To: " + to),
            function (err, ok) {
              if (!ok) return next();
              console.log("Moving");
              fs.move(from, to, next);
            }
          );
        },
        callback
      );
    }, callback);
  });
}
