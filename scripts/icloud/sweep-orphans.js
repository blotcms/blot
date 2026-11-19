// Lists the macserver's blog folders that no connected blog owns, and with
// --apply removes them, as the daily sweep does (clients/icloud/sweepOrphans.js).
//
//   node scripts/icloud/sweep-orphans.js           # dry run
//   node scripts/icloud/sweep-orphans.js --apply
const sweepOrphans = require("clients/icloud/sweepOrphans");

const main = async () => {
  const apply = process.argv.includes("--apply");
  const result = await sweepOrphans({ apply });

  console.log(
    `${result.folders} folders, ${result.orphans.length} orphaned` +
      (apply
        ? `, ${result.removed.length} removed, ${result.failed.length} failed`
        : " (dry run: pass --apply to remove them)") +
      (result.refused ? `; ${result.refused}` : "")
  );
};

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("iCloud orphan sweep failed:", error);
      process.exit(1);
    });
}

module.exports = main;
