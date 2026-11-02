// Marks every template that has a directory in its blog's folder (Templates/
// or templates/) as locally edited. readFromFolder now does this on each
// sync; templates read before that change, from a directory with no
// package.json, were left unmarked, so a dashboard edit to one was saved only
// in Redis and overwritten by the blog's next sync.
//
// Dry run by default; pass --apply to write.
// Usage: node scripts/template/mark-folder-templates-local.js [--apply]

const { promisify } = require("util");
const client = require("models/client");
const folder = require("storage/folder");
const Template = require("models/template");
const makeID = require("models/template/util/makeID");
const redisKeys = require("../util/redisKeys");

const APPLY = process.argv.includes("--apply");
const setMetadata = promisify(Template.setMetadata);

const counts = {};
function count(name) {
  counts[name] = (counts[name] || 0) + 1;
}

async function markBlog(blogID) {
  for (const root of ["/Templates", "/templates"]) {
    let entries;
    try {
      entries = await folder.listNames(blogID, root);
    } catch (err) {
      continue;
    }

    for (const entry of entries) {
      if (!entry || !entry.name || entry.name.startsWith(".")) continue;
      if (!entry.isDirectory) continue;

      const id = makeID(blogID, entry.name);
      const [owner, localEditing] = await client.hmGet("template:" + id + ":info", [
        "owner",
        "localEditing",
      ]);

      // A directory the next sync will create a template for
      if (owner !== blogID || localEditing === "true") continue;

      count("templates to mark");
      console.log(APPLY ? "marking:" : "would mark:", id);
      if (APPLY) await setMetadata(id, { localEditing: true });
    }
  }
}

async function main() {
  await redisKeys("blog:*:info", async (key) => {
    if (key.split(":").length !== 3) return;
    if ((await client.type(key)) !== "hash") return;
    await markBlog(key.split(":")[1]);
  });

  console.log(APPLY ? "Applied:" : "Dry run, nothing written:");
  for (const [name, n] of Object.entries(counts)) console.log(" ", name, n);
  if (!Object.keys(counts).length) console.log("  nothing to do");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
