// Copy Git create-status off the user-keyed Redis record onto a per-blog
// key so getHealth (and disconnect) can see the right site.
//
// Usage:
//   node scripts/git/backfill-status-keys.js            # prompts
//   node scripts/git/backfill-status-keys.js --dry-run  # report only
//   node scripts/git/backfill-status-keys.js --yes      # no prompt

const colors = require("colors/safe");
const client = require("models/client");
const database = require("clients/git/database");
const getConfirmation = require("../util/getConfirmation");
const each = require("../each/blog");

function iterateBlogs(runForBlog) {
  return new Promise(function (resolve, reject) {
    each(
      function (user, blog, next) {
        Promise.resolve(runForBlog(user, blog)).then(
          function () {
            next();
          },
          next
        );
      },
      function (err) {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}

function migrateValue(raw) {
  return JSON.stringify(database.parseRecord(raw));
}

async function scanLegacyKeys() {
  const keys = [];
  let cursor = "0";

  do {
    const reply = await client.scan(cursor, {
      MATCH: "user:*:git:status",
      COUNT: 1000,
    });
    const cursorOut = Array.isArray(reply)
      ? String(reply[0] || "0")
      : String(reply.cursor || "0");
    const found = Array.isArray(reply)
      ? reply[1] || []
      : Array.isArray(reply.keys)
      ? reply.keys
      : [];
    cursor = cursorOut;
    for (const key of found) keys.push(key);
  } while (cursor !== "0");

  return keys;
}

async function collectPlan() {
  const copies = [];
  const legacyKeys = new Set();

  await iterateBlogs(async function (user, blog) {
    if (blog.client !== "git") return;

    const newKey = database.statusKey(blog.id);
    const legacyKey = database.legacyStatusKey(blog.owner);
    legacyKeys.add(legacyKey);

    const existing = await client.get(newKey);
    if (existing) return;

    const legacy = await client.get(legacyKey);
    if (!legacy) return;

    copies.push({
      blogID: blog.id,
      newKey: newKey,
      legacyKey: legacyKey,
      value: migrateValue(legacy),
    });
  });

  const leftover = [];
  const scanned = await scanLegacyKeys();
  scanned.forEach(function (key) {
    leftover.push(key);
    legacyKeys.add(key);
  });

  return {
    copies: copies,
    deletes: Array.from(legacyKeys),
    leftover: leftover,
  };
}

async function applyPlan(plan) {
  for (const item of plan.copies) {
    await client.set(item.newKey, item.value);
    console.log("SET", item.newKey, "from", item.legacyKey, "blog", item.blogID);
  }

  for (const key of plan.deletes) {
    const removed = await client.del(key);
    if (removed) console.log("DEL", key);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const skipConfirmation = args.includes("--yes");

  const plan = await collectPlan();

  if (!plan.copies.length && !plan.deletes.length) {
    console.log(colors.green("No Git status keys need migrating."));
    return plan;
  }

  plan.copies.forEach(function (item) {
    console.log(item.blogID, item.legacyKey, "->", item.newKey);
  });

  console.log(
    colors.cyan(
      `Would copy ${plan.copies.length} status record${
        plan.copies.length === 1 ? "" : "s"
      } and delete ${plan.deletes.length} legacy key${
        plan.deletes.length === 1 ? "" : "s"
      }.`
    )
  );

  if (dryRun) {
    console.log(colors.yellow("Dry run: no rows written."));
    return plan;
  }

  if (!skipConfirmation) {
    const confirmed = await getConfirmation(
      `Copy ${plan.copies.length} Git status record${
        plan.copies.length === 1 ? "" : "s"
      } onto per-blog keys and delete legacy user-keyed status?`
    );

    if (!confirmed) {
      console.log(colors.yellow("Aborted without writing any rows."));
      return plan;
    }
  }

  await applyPlan(plan);
  console.log(colors.green("Backfill complete."));
  return plan;
}

if (require.main === module) {
  main()
    .then(function () {
      process.exit(0);
    })
    .catch(function (err) {
      console.error(err);
      process.exit(1);
    });
}

module.exports = {
  collectPlan,
  applyPlan,
  migrateValue,
  main,
};
