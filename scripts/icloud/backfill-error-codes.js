// Classify existing iCloud blog rows that only have a prose `error` string,
// writing a machine-readable `errorCode` so getHealth does not have to infer
// it from the row. getHealth infers the same code for rows without one, so
// running this is optional; it just makes the stored state explicit.
//
// Usage:
//   node scripts/icloud/backfill-error-codes.js            # prompts
//   node scripts/icloud/backfill-error-codes.js --dry-run  # report only
//   node scripts/icloud/backfill-error-codes.js --yes      # no prompt

const colors = require("colors/safe");
const database = require("clients/icloud/database");
const { backfillPatch } = require("clients/icloud/error");
const getConfirmation = require("../util/getConfirmation");

async function collectPatches() {
  const patches = [];

  await database.iterate(async function (blogID, account) {
    const patch = backfillPatch(account);
    if (!patch) return;
    patches.push({ blogID: blogID, patch: patch, error: account.error });
  });

  return patches;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const skipConfirmation = args.includes("--yes");

  const patches = await collectPatches();

  if (!patches.length) {
    console.log(colors.green("No iCloud blog rows need an errorCode backfill."));
    return;
  }

  patches.forEach(function (item) {
    console.log(
      item.blogID,
      JSON.stringify(item.patch),
      item.error ? JSON.stringify(item.error) : ""
    );
  });

  console.log(
    colors.cyan(
      `Found ${patches.length} blog${patches.length === 1 ? "" : "s"} to update.`
    )
  );

  if (dryRun) {
    console.log(colors.yellow("Dry run: no rows written."));
    return;
  }

  if (!skipConfirmation) {
    const confirmed = await getConfirmation(
      `Write errorCode onto ${patches.length} iCloud blog row${
        patches.length === 1 ? "" : "s"
      }?`
    );

    if (!confirmed) {
      console.log(colors.yellow("Aborted without writing any rows."));
      return;
    }
  }

  // Rows can change while the operator reads the report (e.g. a user
  // reconnects), so recompute each patch against the current row.
  for (const item of patches) {
    const patch = backfillPatch(await database.get(item.blogID));
    if (!patch) {
      console.log("skipped (changed since scan)", item.blogID);
      continue;
    }
    // No `error` key, so store() writes the patch as is
    await database.store(item.blogID, patch);
    console.log("updated", item.blogID);
  }

  console.log(colors.green("Backfill complete."));
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

module.exports = { collectPatches, main };
