var get = require("../get/entry");
var client = require("models/client");

if (require.main === module) {
  wipeCaches(process.argv[2]).then(
    () => {
      console.log("Done!");
      process.exit();
    },
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}

async function wipeCaches(url) {
  console.log("Looking up", url);

  const { blog, entry } = await get(url);

  if (!entry) throw new Error("No entry");

  console.log("Wiping thumbnails for", entry.path);
  await wipeThumbnails(blog, entry);

  console.log("Wiping image cache for", entry.path);
  await wipeImageCache(blog, entry);
}

async function wipeImageCache(blog, entry) {
  if (!entry.thumbnail.small || !entry.thumbnail.small.name) return;

  var set = "blog:" + blog.id + ":store:image-cache:everything";

  var keys = await client.sMembers(set);

  await Promise.all(
    keys.map(async function (key) {
      var res = await client.get(key);

      if (!res) return;

      try {
        res = JSON.parse(res);
      } catch (e) {
        console.log(e.message);
        return;
      }

      if (entry.html.indexOf(res.src) === -1) return;

      console.log(res.src, "wiped");

      await client.multi().sRem(set, key).del(key).exec();
    })
  );
}

async function wipeThumbnails(blog, entry) {
  if (!entry.thumbnail.small || !entry.thumbnail.small.name) return;

  var set = "blog:" + blog.id + ":store:thumbnails:everything";

  var keys = await client.sMembers(set);

  await Promise.all(
    keys.map(async function (key) {
      var res = await client.get(key);

      try {
        res = JSON.parse(res);
        if (res.small.name !== entry.thumbnail.small.name) return;
      } catch (e) {
        console.log("Error", key, e.message);
        return;
      }

      console.log(entry.thumbnail.small.url, "wiped");

      await client.multi().sRem(set, key).del(key).exec();
    })
  );
}

module.exports = wipeCaches;
