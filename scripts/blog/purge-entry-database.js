const colors = require("colors/safe");
const getBlog = require("../get/blog");
const redisKeys = require("../util/redisKeys");
const client = require("models/client");
const getConfirmation = require("../util/getConfirmation");

const ENTRY_LISTS = [
  "all",
  "created",
  "entries",
  "drafts",
  "scheduled",
  "pages",
  "deleted",
];

async function collectKeys(blog) {
  const blogPrefix = `blog:${blog.id}:`;
  const patterns = [
    ...ENTRY_LISTS.map((list) => `${blogPrefix}${list}`),
    `${blogPrefix}entry:*`,
    `${blogPrefix}url:*`,
    `${blogPrefix}dependents:*`,
    `${blogPrefix}tags:all`,
    `${blogPrefix}tags:entries-by-dateStamp:*`,
    `${blogPrefix}tags:entry:*`,
    `${blogPrefix}tags:name:*`,
    `${blogPrefix}ignored_files`,
  ];

  const keys = new Set();

  for (const pattern of patterns) {
    await redisKeys(pattern, async (key) => {
      if (key.startsWith(blogPrefix)) {
        keys.add(key);
      }
    });
  }

  return Array.from(keys);
}

async function main(blog) {
  const keys = await collectKeys(blog);

  if (!keys.length) {
    console.log(colors.yellow("No keys to delete."));
    return;
  }

  console.log(colors.cyan("Found the following keys:"));
  console.log(JSON.stringify(keys, null, 2));

  const confirmed = await getConfirmation(`Delete ${keys.length} keys`);

  if (!confirmed) {
    console.log(colors.yellow("Aborted without deleting any keys."));
    return;
  }

  const multi = client.multi();
  multi.del(keys);
  const results = await multi.exec();

  const deleted = Array.isArray(results)
    ? results.reduce(
        (sum, value) => sum + (typeof value === "number" ? value : 0),
        0
      )
    : 0;
  console.log(
    colors.green(
      `Deleted ${keys.length} keys for blog ${blog.id}. Redis removed ${deleted} keys.`
    )
  );
}

async function cli() {
  const { blog } = await getBlog(process.argv[2]);

  try {
    await main(blog);
  } catch (error) {
    console.error(colors.red("Error:", error.message));
    return process.exit(1);
  }

  process.exit();
}

if (require.main === module) {
  cli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = main;
