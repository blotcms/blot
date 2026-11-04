// Mirrors entries, their tags and their dependencies from Redis into Postgres
// (see README). Redis stays the source of truth until reads move over: every
// Postgres row is derived from an entry's JSON in Redis, and a failed
// Postgres write never fails the Redis one. It puts the blog in a dirty set
// instead, which the scheduler repairs hourly (repairDirty).
//
// The one primitive is syncPaths: for each path it takes a transaction-scoped
// advisory lock, reads the entry from Redis, then writes (or deletes) the
// path's rows. Since every writer reads Redis only once it holds the lock, the
// last writer to get the lock wrote whatever Redis holds now, so live saves
// (Entry.set), the backfill and the repair can run at once in any order and
// still leave Postgres matching Redis.
const postgres = require("./index");
const redis = require("models/client");
const clfdate = require("helper/clfdate");
const pathNormalize = require("helper/pathNormalizer");
const entryKey = require("models/entry/key").entry;
const tagsForEntry = require("models/tags/forEntry");

// Blogs whose Postgres rows may not match Redis
const DIRTY_KEY = "postgres:entries:dirty";

// Paths per transaction. Each holds an advisory lock until its transaction
// ends, and locks share Postgres's lock table (max_locks_per_transaction)
const BATCH_SIZE = 25;

// After a failed write, later saves skip Postgres for this long and just mark
// their blog dirty, so a Postgres outage doesn't add a connect timeout to
// every save in every sync
const BACKOFF_MS = 30 * 1000;

let backoffUntil = 0;

// The hourly repair stops after this many blogs fail one after another
const MAX_FAILURES_IN_A_ROW = 3;

const PRUNE_MARGIN_MS = 60 * 60 * 1000;

// jsonb refuses NUL characters and lone surrogates, and text columns NUL.
// They are replaced in every string (keys included) before writing, and
// verify.js compares Redis's JSON through the same function.
function sanitize(value) {
  if (typeof value === "string") {
    return value.indexOf("\u0000") === -1 && value.isWellFormed()
      ? value
      : value.replace(/\u0000/g, "").toWellFormed();
  }

  if (Array.isArray(value)) return value.map(sanitize);

  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value)) result[sanitize(key)] = sanitize(value[key]);
    return result;
  }

  return value;
}

function number(value, fallback) {
  return typeof value === "number" && isFinite(value) ? value : fallback;
}

// The rows for one entry, as read from Redis. deletedAt is its score in the
// "deleted" list, ttl the key's PTTL (negative when it doesn't expire).
function rowsFor(blogID, path, entry, { deletedAt = null, ttl = -1, now = Date.now() } = {}) {
  entry = sanitize(entry);

  const created = number(entry.created, now);
  const dateStamp = number(entry.dateStamp, created);

  const row = {
    blog_id: blogID,
    path,
    id: typeof entry.id === "string" ? entry.id : path,
    guid: entry.guid || "",
    url: entry.url || "",
    permalink: entry.permalink || "",
    title: entry.title || "",
    draft: !!entry.draft,
    page: !!entry.page,
    menu: !!entry.menu,
    scheduled: !!entry.scheduled,
    deleted: !!entry.deleted,
    date_stamp: dateStamp,
    created,
    updated: number(entry.updated, created),
    deleted_at: entry.deleted ? number(deletedAt, now) : null,
    expires_at: ttl > 0 ? now + ttl : null,
    data: entry,
  };

  const listed = tagsForEntry({
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    path: typeof entry.path === "string" ? entry.path : path,
    deleted: entry.deleted,
    draft: entry.draft,
    scheduled: entry.scheduled,
    page: entry.page,
    menu: entry.menu,
  });

  const tags = listed.tags.map((tag, i) => ({
    blog_id: blogID,
    path,
    tag,
    name: listed.names[i],
  }));

  // As in models/entry/_rebuildDependencyGraph: a deleted entry depends on
  // nothing, and paths which differ only by case share a key
  const dependencies = [];
  if (!entry.deleted && Array.isArray(entry.dependencies)) {
    const seen = new Set();
    for (const dependency of entry.dependencies) {
      if (typeof dependency !== "string") continue;
      const key = pathNormalize(dependency).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      dependencies.push({ blog_id: blogID, path, dependency_key: key, dependency });
    }
  }

  return { entry: row, tags, dependencies };
}

// Reads each path's entry, TTL and "deleted" score from Redis. Returns [{ path, entry (null when there is no key), deletedAt, ttl }].
async function readFromRedis(blogID, paths) {
  const multi = redis.multi();
  const deletedKey = "blog:" + blogID + ":deleted";

  for (const path of paths) {
    multi.get(entryKey(blogID, path));
    multi.pTTL(entryKey(blogID, path));
  }

  const replies = await multi.exec();

  const found = paths.map((path, i) => {
    const json = replies[i * 2];
    let entry = null;

    if (json) {
      try {
        entry = JSON.parse(json);
      } catch (err) {
        err.message = "Unparseable entry " + blogID + " " + path + ": " + err.message;
        throw err;
      }
    }

    return { path, entry, ttl: Number(replies[i * 2 + 1]), deletedAt: null };
  });

  // The deleted list holds entry.id, which can differ from the normalized
  // path the key uses
  const deleted = found.filter((item) => item.entry && item.entry.deleted);

  if (deleted.length) {
    const scores = redis.multi();
    for (const item of deleted) scores.zScore(deletedKey, item.entry.id || item.path);
    const replies = await scores.exec();
    deleted.forEach((item, i) => {
      item.deletedAt = replies[i] === null ? null : Number(replies[i]);
    });
  }

  return found;
}

const ENTRY_COLUMNS = [
  ["blog_id", "text"],
  ["path", "text"],
  ["id", "text"],
  ["guid", "text"],
  ["url", "text"],
  ["permalink", "text"],
  ["title", "text"],
  ["draft", "boolean"],
  ["page", "boolean"],
  ["menu", "boolean"],
  ["scheduled", "boolean"],
  ["deleted", "boolean"],
  ["date_stamp", "double precision"],
  ["created", "double precision"],
  ["updated", "double precision"],
  ["deleted_at", "double precision"],
  ["expires_at", "double precision"],
  ["data", "jsonb"],
];

const recordset = (columns) =>
  "jsonb_to_recordset($1::jsonb) AS r(" +
  columns.map(([name, type]) => name + " " + type).join(", ") +
  ")";

const UPSERT_ENTRIES =
  "INSERT INTO entries (" +
  ENTRY_COLUMNS.map(([name]) => name).join(", ") +
  ") SELECT " +
  ENTRY_COLUMNS.map(([name]) => "r." + name).join(", ") +
  " FROM " +
  recordset(ENTRY_COLUMNS) +
  " ON CONFLICT (blog_id, path) DO UPDATE SET " +
  ENTRY_COLUMNS.slice(2)
    .map(([name]) => name + " = excluded." + name)
    .join(", ");

const INSERT_TAGS =
  "INSERT INTO entry_tags (blog_id, path, tag, name) SELECT r.blog_id, r.path, r.tag, r.name FROM " +
  recordset([
    ["blog_id", "text"],
    ["path", "text"],
    ["tag", "text"],
    ["name", "text"],
  ]);

const INSERT_DEPENDENCIES =
  "INSERT INTO entry_dependencies (blog_id, path, dependency_key, dependency) " +
  "SELECT r.blog_id, r.path, r.dependency_key, r.dependency FROM " +
  recordset([
    ["blog_id", "text"],
    ["path", "text"],
    ["dependency_key", "text"],
    ["dependency", "text"],
  ]);

// Locks are taken in path order, so two batches of the same blog never wait
// on each other in a cycle (a live save only ever takes one)
const LOCK_PATHS =
  "SELECT pg_advisory_xact_lock(k) FROM " +
  "(SELECT hashtextextended($1 || ':' || p, 0) AS k FROM unnest($2::text[]) AS p ORDER BY p) AS locks";

async function syncBatch(blogID, paths) {
  return postgres.transaction(async function (db) {
    await db.query(LOCK_PATHS, [blogID, paths]);

    const found = await readFromRedis(blogID, paths);
    const now = Date.now();
    const present = [];
    const missing = [];
    const entries = [];
    const tags = [];
    const dependencies = [];

    for (const item of found) {
      if (!item.entry) {
        missing.push(item.path);
        continue;
      }

      const rows = rowsFor(blogID, item.path, item.entry, {
        deletedAt: item.deletedAt,
        ttl: item.ttl,
        now,
      });

      present.push(item.path);
      entries.push(rows.entry);
      tags.push(...rows.tags);
      dependencies.push(...rows.dependencies);
    }

    if (missing.length) {
      // Cascades to the entry's tags and dependencies
      await db.query("DELETE FROM entries WHERE blog_id = $1 AND path = ANY($2::text[])", [
        blogID,
        missing,
      ]);
    }

    if (present.length) {
      await db.query(UPSERT_ENTRIES, [JSON.stringify(entries)]);
      await db.query("DELETE FROM entry_tags WHERE blog_id = $1 AND path = ANY($2::text[])", [
        blogID,
        present,
      ]);
      await db.query(
        "DELETE FROM entry_dependencies WHERE blog_id = $1 AND path = ANY($2::text[])",
        [blogID, present]
      );
      if (tags.length) await db.query(INSERT_TAGS, [JSON.stringify(tags)]);
      if (dependencies.length) await db.query(INSERT_DEPENDENCIES, [JSON.stringify(dependencies)]);
    }

    return { written: present.length, removed: missing.length };
  });
}

// Makes the rows of each path match Redis. Returns { written, removed }.
async function syncPaths(blogID, paths) {
  const unique = Array.from(new Set(paths.map((path) => pathNormalize(path)))).sort();
  const totals = { written: 0, removed: 0 };

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const result = await syncBatch(blogID, unique.slice(i, i + BATCH_SIZE));
    totals.written += result.written;
    totals.removed += result.removed;
  }

  return totals;
}

// Every path Redis lists for the blog, and every path Postgres has a row for
async function pathsOf(blogID) {
  const [listed, { rows }] = await Promise.all([
    redis.zRange("blog:" + blogID + ":all", 0, -1),
    postgres.query("SELECT path FROM entries WHERE blog_id = $1", [blogID]),
  ]);

  return listed.concat(rows.map((row) => row.path));
}

// Makes every row of the blog match Redis: the backfill, and the repair of a
// dirty blog. A blog that no longer exists ends up with no rows.
async function syncBlog(blogID) {
  return syncPaths(blogID, await pathsOf(blogID));
}

async function markDirty(blogID) {
  try {
    await redis.sAdd(DIRTY_KEY, blogID);
  } catch (err) {
    // Redis is down too, so the Redis write this follows has most likely
    // failed as well. The daily verify catches whatever this loses.
    console.error(clfdate(), blogID.slice(0, 12), "Postgres: could not mark blog dirty", err.message);
  }
}

// Called by Entry.set after each Redis write. Never rejects: a failure marks
// the blog dirty for the hourly repair.
async function afterSet(blogID, path) {
  if (!postgres.enabled()) return;

  if (Date.now() < backoffUntil) return markDirty(blogID);

  try {
    await syncPaths(blogID, [path]);
  } catch (err) {
    backoffUntil = Date.now() + BACKOFF_MS;
    console.error(clfdate(), blogID.slice(0, 12), "Postgres: entry write failed", path, err.message);
    await markDirty(blogID);
  }
}

// Called when a blog is deleted, after its Redis keys are gone. Never rejects.
async function afterBlogRemoved(blogID) {
  if (!postgres.enabled()) return;

  try {
    await postgres.query("DELETE FROM entries WHERE blog_id = $1", [blogID]);
  } catch (err) {
    console.error(clfdate(), blogID.slice(0, 12), "Postgres: removing blog's entries failed", err.message);
    // The repair finds no entries in Redis and removes the rows
    await markDirty(blogID);
  }
}

// Syncs every blog in the dirty set. A blog that fails again stays in it, and
// after a few failures in a row (Postgres is down) the rest wait for the next
// run. Returns { repaired, failed }.
async function repairDirty({ log = () => {} } = {}) {
  const result = { repaired: 0, failed: 0 };
  let failedInARow = 0;

  if (!postgres.enabled()) return result;

  const blogIDs = await redis.sMembers(DIRTY_KEY);

  for (const blogID of blogIDs) {
    if (failedInARow >= MAX_FAILURES_IN_A_ROW) break;

    // Removed before the sync, so a save that fails during it marks the blog
    // dirty again rather than being lost
    await redis.sRem(DIRTY_KEY, blogID);

    try {
      const totals = await syncBlog(blogID);
      result.repaired++;
      failedInARow = 0;
      log(blogID, "repaired:", totals.written, "written,", totals.removed, "removed");
    } catch (err) {
      result.failed++;
      failedInARow++;
      log(blogID, "repair failed:", err.message);
      await markDirty(blogID);
    }
  }

  return result;
}

// Deletes the rows of deleted entries whose Redis key has expired. Nothing
// else would, short of a full sync of their blog. The margin keeps a row
// whose key Redis has yet to expire. Not locked: a save which brings the
// entry back clears expires_at, and the DELETE re-checks the row it waited
// on. Returns the number of rows deleted.
async function pruneExpired() {
  if (!postgres.enabled()) return 0;

  const { rowCount } = await postgres.query(
    "DELETE FROM entries WHERE expires_at < $1",
    [Date.now() - PRUNE_MARGIN_MS]
  );

  return rowCount;
}

module.exports = {
  DIRTY_KEY,
  sanitize,
  rowsFor,
  syncPaths,
  syncBlog,
  afterSet,
  afterBlogRemoved,
  repairDirty,
  pruneExpired,
  // For tests
  _resetBackoff: () => {
    backoffUntil = 0;
  },
};
