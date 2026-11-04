// Applies the pending Postgres migrations (app/models/postgres/migrations).
// Safe to run more than once, and from several processes at once.
//
// Usage: node scripts/postgres/migrate.js [--dry-run]
const postgres = require("models/postgres");
const migrate = require("models/postgres/migrate");

const dryRun = process.argv.includes("--dry-run");

(async function main() {
  if (!postgres.enabled()) throw new Error("Set BLOT_POSTGRES_URL first");

  const names = await migrate({ dryRun, log: (line) => console.log(line) });

  if (!names.length) console.log("Nothing to apply: the schema is up to date");
  else if (dryRun) console.log("Would apply:\n  " + names.join("\n  "));
  else console.log("Applied " + names.length + " migration(s)");
})()
  .then(() => postgres.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
