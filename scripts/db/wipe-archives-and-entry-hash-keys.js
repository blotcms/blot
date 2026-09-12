// Wipes the Redis keys left behind by the reverted archives-index and
// entry-hash rollout (the archives-index PR, and the entry-hash stage 1/2
// dual-write + read PRs, all fully reverted).
//
// Deletes two key families:
//   blog:*:archives:*      - archives index (buckets, months, entry->bucket,
//                            ready flag, generation counter). Nothing reads
//                            or writes these any more; safe to delete outright.
//   blog:*:entry:hash:*    - Redis-hash mirror of each entry: dual-written by
//                            app/models/entry/set.js and populated by
//                            scripts/entry/backfill-hashes.js (both removed).
//                            Nothing reads or writes these any more either,
//                            so unlike an earlier version of this script,
//                            deleting them is permanent - nothing recreates
//                            them.
//
// Keys are streamed off SCAN and deleted in bounded batches rather than
// collected into memory first, so this stays cheap to run against a
// production-sized backlog of hash keys.
//
// Usage:
//   node scripts/db/wipe-archives-and-entry-hash-keys.js            # prompts before deleting
//   node scripts/db/wipe-archives-and-entry-hash-keys.js --dry-run  # count only, no prompt, no deletes
//   node scripts/db/wipe-archives-and-entry-hash-keys.js --yes      # skip the confirmation prompt

const colors = require("colors/safe");
const client = require("models/client");
const redisKeys = require("../util/redisKeys");
const getConfirmation = require("../util/getConfirmation");

const PATTERNS = ["blog:*:archives:*", "blog:*:entry:hash:*"];
const DELETE_BATCH_SIZE = 500;

async function countKeys(pattern) {
  let count = 0;
  await redisKeys(pattern, async () => {
    count++;
  });
  return count;
}

async function deleteBatch(batch) {
  if (!batch.length) return 0;

  return new Promise((resolve, reject) => {
    const multi = client.multi();
    batch.forEach((key) => multi.del(key));
    multi
      .exec()
      .then((results) => {
        const deleted = Array.isArray(results)
          ? results.reduce(
              (sum, value) => sum + (typeof value === "number" ? value : 0),
              0
            )
          : 0;
        resolve(deleted);
      })
      .catch(reject);
  });
}

// Streams matching keys off SCAN, deleting them in bounded batches instead
// of collecting every match into memory first.
async function deletePattern(pattern) {
  let batch = [];
  let totalDeleted = 0;

  await redisKeys(pattern, async (key) => {
    batch.push(key);

    if (batch.length >= DELETE_BATCH_SIZE) {
      totalDeleted += await deleteBatch(batch);
      batch = [];
    }
  });

  totalDeleted += await deleteBatch(batch);

  return totalDeleted;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const skipConfirmation = args.includes("--yes");

  const countsByPattern = new Map();
  let totalCount = 0;

  for (const pattern of PATTERNS) {
    const count = await countKeys(pattern);
    countsByPattern.set(pattern, count);
    totalCount += count;
    console.log(
      colors.cyan(`${pattern}: found ${count} key${count === 1 ? "" : "s"}`)
    );
  }

  if (!totalCount) {
    console.log(colors.green("No matching keys found. Nothing to do."));
    return;
  }

  if (dryRun) {
    console.log(
      colors.yellow(`Dry run: would delete ${totalCount} key${totalCount === 1 ? "" : "s"} total.`)
    );
    return;
  }

  if (!skipConfirmation) {
    const confirmed = await getConfirmation(
      `Delete ${totalCount} key${totalCount === 1 ? "" : "s"} across ${PATTERNS.length} pattern(s)?`
    );

    if (!confirmed) {
      console.log(colors.yellow("Aborted without deleting any keys."));
      return;
    }
  }

  let totalDeleted = 0;

  for (const pattern of PATTERNS) {
    totalDeleted += await deletePattern(pattern);
  }

  console.log(
    colors.green(
      `Found ${totalCount} key${totalCount === 1 ? "" : "s"}. Redis removed ${totalDeleted} key${totalDeleted === 1 ? "" : "s"}.`
    )
  );
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(colors.red("Error:", error.message));
      process.exit(1);
    });
}

module.exports = main;
