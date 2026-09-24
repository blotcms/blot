const database = require("clients/icloud/database");
const { backfillFields } = require("clients/icloud/error");

const apply = process.argv.includes("--apply");

const main = async () => {
  let examined = 0;
  let wouldUpdate = 0;
  let updated = 0;
  let skipped = 0;

  await database.iterate(async (blogID, account) => {
    examined++;
    const fields = backfillFields(account);

    if (!fields) {
      skipped++;
      return;
    }

    wouldUpdate++;
    console.log(
      apply ? "UPDATE" : "DRY-RUN",
      blogID,
      JSON.stringify({
        error: account.error,
        errorCode: account.errorCode || null,
        nextErrorCode: fields.errorCode,
      })
    );

    if (apply) {
      await database.store(blogID, fields);
      updated++;
    }
  });

  console.log(
    "iCloud error-code backfill",
    JSON.stringify({
      examined,
      skipped,
      wouldUpdate,
      updated: apply ? updated : 0,
      apply,
    })
  );

  if (!apply && wouldUpdate > 0) {
    console.log("Re-run with --apply to write errorCode / errorSince.");
  }
};

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Failed to backfill iCloud error codes:", error);
      process.exit(1);
    });
}

module.exports = main;
