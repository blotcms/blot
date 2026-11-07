var get = require("../get/entry");
var establishSyncLock = require("sync/establishSyncLock");
var wipeCaches = require("./wipe-image-and-thumbnail-cache");

if (!process.argv[2]) {
  console.log(
    "Please pass a URL to a blog post or file to this script. Blot will rebuild the entry which exists at that URL."
  );
  process.exit();
}

async function rebuild(url) {
  // Will rebuild and recache any thumbnails or images
  console.log("Getting info from:", url);

  const { blog, entry } = await get(url);

  var path;

  if (entry) {
    path = entry.path;
  } else {
    path = decodeURIComponent(require("url").parse(url).path);
  }

  console.log("Starting sync for", blog.handle);

  const lock = await establishSyncLock(blog.id);

  try {
    await wipeCaches(url);
  } catch (err) {
    console.log(err);
  }

  await lock.folder.update(path);
  await lock.done();

  console.log("Rebuilt:", url);
}

rebuild(process.argv[2]).then(
  () => process.exit(),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
