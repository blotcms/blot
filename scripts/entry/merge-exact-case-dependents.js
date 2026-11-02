// Moves every dependents set still under its exact-case key
// (blog:<id>:dependents:/Photo.JPG) onto the lowercased key the app reads
// (blog:<id>:dependents:/photo.jpg), merging with any set already there, then
// deletes the exact-case key. Run it before deploying the code that stops
// reading exact-case keys: the code before that reads both, so a merge it
// sees half done changes nothing.
//
// Dry run by default. Pass --apply to write.
// Usage: node scripts/entry/merge-exact-case-dependents.js [--apply]

const client = require("models/client");
const redisKeys = require("../util/redisKeys");

const APPLY = process.argv.includes("--apply");
const KEY_FORMAT = /^(blog:[^:]+:dependents:)(.*)$/;

async function main() {
  const blogs = new Set();
  let merged = 0;

  await redisKeys("blog:*:dependents:*", async (key) => {
    const match = key.match(KEY_FORMAT);
    if (!match) return;

    const lowercased = match[1] + match[2].toLowerCase();
    if (lowercased === key) return;

    merged++;
    blogs.add(key.split(":")[1]);

    if (!APPLY) return;

    await client
      .multi()
      .sUnionStore(lowercased, [lowercased, key])
      .del(key)
      .exec();
  });

  console.log(
    (APPLY ? "Merged " : "Would merge ") +
      merged +
      " exact-case dependents keys across " +
      blogs.size +
      " blogs"
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
