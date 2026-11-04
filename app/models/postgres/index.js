// The shared Postgres connection pool, for the tables written alongside Redis
// (see README). Nothing connects until the first query, and when
// BLOT_POSTGRES_URL is unset enabled() is false and every caller skips
// Postgres altogether.
const { Pool } = require("pg");
const config = require("config");
const clfdate = require("helper/clfdate");

// Long enough for a write under load, short enough that a stalled Postgres
// can't hold up a sync for long (callers treat a failure as "repair later")
const STATEMENT_TIMEOUT_MS = 10 * 1000;
const CONNECT_TIMEOUT_MS = 5 * 1000;

let pool = null;

function enabled() {
  return !!config.postgres.url;
}

function getPool() {
  if (!enabled()) throw new Error("Postgres is not configured (BLOT_POSTGRES_URL)");

  if (!pool) {
    pool = new Pool({
      connectionString: config.postgres.url,
      max: config.postgres.poolSize,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      idleTimeoutMillis: 30 * 1000,
      application_name: config.container || "blot",
    });

    // An idle connection that drops (a Postgres restart) emits here. Without
    // a listener it would crash the process; the pool replaces it.
    pool.on("error", function (err) {
      console.error(clfdate(), "Postgres: idle connection error", err.message);
    });
  }

  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

// A client of its own, for a session-level lock. The caller must release() it
function connect() {
  return getPool().connect();
}

// Runs fn(client) inside BEGIN ... COMMIT, rolling back if it throws.
async function transaction(fn) {
  const client = await getPool().connect();
  let released = false;

  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      // The connection is broken: drop it rather than return it to the pool
      client.release(rollbackErr);
      released = true;
    }
    throw err;
  } finally {
    if (!released) client.release();
  }
}

// For scripts and tests, so the process can exit
async function end() {
  if (!pool) return;
  const ending = pool;
  pool = null;
  await ending.end();
}

module.exports = { enabled, query, connect, transaction, end };
