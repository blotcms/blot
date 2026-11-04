# models/postgres

Postgres, alongside Redis, for entries, their tags and their dependencies.
Redis keeps locks, sessions, pub/sub, rate limits, caches and everything else.

This is the dual-write stage. Every `Entry.set` (and so every build, drop,
backlink update and scheduled publish) writes Redis as before, then the
entry's rows here. Nothing reads from Postgres yet, and Redis is still the
source of truth: every row is derived from the entry's JSON in Redis, so the
tables can be dropped and rebuilt from Redis at any time. A follow-up moves
the reads over and removes the Redis entry keys, lists, tag sets, dependents
sets and URL keys, along with `Fix()`'s list and tag repairs and the
client-side cache's entry keys.

With `BLOT_POSTGRES_URL` unset, nothing here runs.

## Files

| File | What it does |
| --- | --- |
| `index.js` | The connection pool (`BLOT_POSTGRES_URL`, `BLOT_POSTGRES_POOL_SIZE` per process), `query`, `transaction`. |
| `migrate.js`, `migrations/*.sql` | The schema. Applied by `scripts/postgres/migrate.js` before a deploy, by the test runner, and on boot in development. Never edit a migration that has run in production: add one. |
| `entries.js` | The dual write: `syncPaths`, `syncBlog`, the hooks `Entry.set` and `Blog.remove` call, and the dirty-set repair. |
| `queries.js` | The Redis indexes as queries: the lists (`entries`, `pages`, `drafts`, `scheduled`, `deleted`, `created`, `all`), tagged entries, dependents, the entry at a URL. Not used by the app yet. |
| `verify.js` | Compares a blog's rows and the queries with Redis. |

## Tables

- `entries`: one row per Redis entry key, keyed by blog ID and normalized path.
  The entry's JSON is in `data`; the columns the indexes need (flags, dates,
  URL) are copied out. A deleted entry keeps its row, with `deleted_at` (its
  score in the "deleted" list) and `expires_at` (when Redis expires its key);
  queries skip rows past `expires_at`, and the hourly job deletes them.
- `entry_tags`: the tags an entry is listed under (`models/tags/forEntry`:
  none for a draft, page, scheduled, deleted or `_`-prefixed entry).
- `entry_dependencies`: the files an entry depends on, keyed as the Redis
  dependents sets are (normalized, lowercased).

A list or index is a query over these, so there is nothing to keep in step:
moving an entry from draft to published is one row update.

## Keeping Postgres in step with Redis

`syncPaths(blogID, paths)` is the only writer. For each batch of paths it
opens a transaction, takes an advisory lock per path (in path order), reads
the entries from Redis, then upserts their rows (or deletes them, when the
key is gone). Since every writer reads Redis only while it holds the lock,
the last writer to get it writes what Redis holds now. So a live save, the
backfill and the repair can overlap in any order and still leave the rows
matching Redis, without a sync lock.

`Entry.set` calls it after its Redis writes and lists. A failure there is
logged and never fails the save: the blog goes in the Redis set
`postgres:entries:dirty`, and for 30 seconds later saves skip Postgres and
mark their blog dirty, so an outage doesn't add a connect timeout to every
save. The scheduler's hourly `postgres-entries-repair` re-syncs every dirty
blog, then deletes the rows of deleted entries whose Redis key has expired.
A blog removed from Redis has its rows deleted (`Blog.remove`), and a dirty
blog with no entries left loses its rows on repair.

## Scripts

```bash
node scripts/postgres/migrate.js [--dry-run]
```

```bash
node scripts/postgres/backfill.js [blog] [--verify [--fix]] [--dirty] [-s n]
```

`backfill.js` with no flags copies every blog (or one). `--verify` reports,
per blog, the entry rows which differ from Redis and the Redis indexes the
queries disagree with (ids in a Redis list whose entry key is gone are left
to `Fix()`); `--fix` re-syncs the entries which differ. An index difference
with matching rows means the Redis index drifted or the query is wrong: work
out which before moving that read over.
