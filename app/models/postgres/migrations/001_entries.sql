-- Entries, their tags and their dependencies, written alongside Redis
-- (app/models/postgres/entries.js). Every row is derived from the entry's
-- JSON in Redis, so the tables can be rebuilt from it at any time
-- (scripts/postgres/backfill.js).
--
-- Times are milliseconds since the epoch, as in the entry JSON. They are
-- double precision rather than bigint because Redis stores them as sorted-set
-- scores (doubles) and nothing guarantees the JSON holds integers.

CREATE TABLE entries (
  blog_id text NOT NULL,
  -- The normalized path (helper/pathNormalizer), as in the Redis entry key
  path text NOT NULL,
  -- entry.id, which the Redis lists hold
  id text NOT NULL,
  guid text NOT NULL DEFAULT '',
  url text NOT NULL DEFAULT '',
  permalink text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  draft boolean NOT NULL DEFAULT false,
  page boolean NOT NULL DEFAULT false,
  menu boolean NOT NULL DEFAULT false,
  scheduled boolean NOT NULL DEFAULT false,
  deleted boolean NOT NULL DEFAULT false,
  date_stamp double precision NOT NULL,
  created double precision NOT NULL,
  updated double precision NOT NULL,
  -- When the entry was deleted: the score of the blog's "deleted" list
  deleted_at double precision,
  -- When Redis expires a deleted entry (DELETED_ENTRY_TTL_SECONDS). Queries
  -- treat a row past it as gone; the hourly prune deletes it.
  expires_at double precision,
  -- The whole entry, as stored in Redis (NUL characters and lone surrogates,
  -- which jsonb refuses, replaced)
  data jsonb NOT NULL,
  PRIMARY KEY (blog_id, path)
);

-- The blog's posts, newest first: the Redis "entries" list
CREATE INDEX entries_published ON entries (blog_id, date_stamp DESC)
  WHERE NOT (draft OR page OR menu OR scheduled OR deleted);

-- The "all" and "created" lists
CREATE INDEX entries_created ON entries (blog_id, created DESC);

-- getByUrl. Not unique: Redis lets a stale URL claim linger, and the mirror
-- must never refuse a write Redis accepted
CREATE INDEX entries_url ON entries (blog_id, url) WHERE url <> '';

CREATE INDEX entries_guid ON entries (blog_id, guid);

-- The hourly prune of deleted entries Redis has expired
CREATE INDEX entries_expires ON entries (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE entry_tags (
  blog_id text NOT NULL,
  path text NOT NULL,
  -- models/tags/normalize
  tag text NOT NULL,
  -- The tag as the entry spells it
  name text NOT NULL,
  PRIMARY KEY (blog_id, path, tag),
  FOREIGN KEY (blog_id, path) REFERENCES entries (blog_id, path) ON DELETE CASCADE
);

CREATE INDEX entry_tags_tag ON entry_tags (blog_id, tag);

CREATE TABLE entry_dependencies (
  blog_id text NOT NULL,
  -- The entry which depends on the file
  path text NOT NULL,
  -- The file's normalized, lowercased path, as in the Redis dependents key
  dependency_key text NOT NULL,
  -- The path as the entry lists it
  dependency text NOT NULL,
  PRIMARY KEY (blog_id, path, dependency_key),
  FOREIGN KEY (blog_id, path) REFERENCES entries (blog_id, path) ON DELETE CASCADE
);

CREATE INDEX entry_dependencies_dependency ON entry_dependencies (blog_id, dependency_key);
