const database = require("clients/icloud/database");
const statistics = require("clients/icloud/statistics");

const main = async () => {
  const blogIDs = await database.list();
  const accounts = await Promise.all(
    blogIDs.map((blogID) => database.get(blogID))
  );
  const existingAccounts = accounts.filter(Boolean);
  const missingRecords = accounts.length - existingAccounts.length;
  const summary = statistics.summarize(existingAccounts);

  console.log(statistics.format({ ...summary, missingRecords }));
};

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Failed to calculate iCloud client statistics:", error);
      process.exit(1);
    });
}

module.exports = main;
