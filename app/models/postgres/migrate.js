// Applies the SQL files in ./migrations that haven't been applied yet, in
// name order, each in its own transaction, and records them in
// schema_migrations. A session advisory lock lets only one process migrate at
// a time; any other waits, then finds nothing left to do.
//
// Run before a deploy that needs the new schema (scripts/postgres/migrate.js).
// Never edit a migration once it has run in production: add a new file.
const fs = require("fs");
const path = require("path");
const postgres = require("./index");

const DIRECTORY = path.join(__dirname, "migrations");

// An arbitrary constant, the same in every process
const LOCK_ID = 7461322;

function files() {
  return fs
    .readdirSync(DIRECTORY)
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
}

async function applied(client) {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  const { rows } = await client.query("SELECT version FROM schema_migrations");
  return new Set(rows.map((row) => row.version));
}

// Returns the names of the migrations it applied, or with { dryRun: true }
// the ones it would.
async function migrate({ dryRun = false, log = () => {} } = {}) {
  const client = await postgres.connect();

  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_ID]);

    const done = await applied(client);
    const pending = files().filter((name) => !done.has(name));

    if (dryRun) return pending;

    for (const name of pending) {
      log("Applying " + name);
      const sql = fs.readFileSync(path.join(DIRECTORY, name), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [name]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        err.message = name + ": " + err.message;
        throw err;
      }
    }

    return pending;
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
    } finally {
      client.release();
    }
  }
}

module.exports = migrate;
module.exports.files = files;
