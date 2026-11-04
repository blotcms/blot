// The Redis indexes over entries (models/entry/_assign.js, models/tags/set.js,
// models/entry/_rebuildDependencyGraph.js, models/entry/_setUrl.js) as
// queries over the Postgres tables. Nothing reads through these yet: verify.js
// checks them against Redis, so reads can move over once they agree.
//
// A deleted entry whose Redis key has expired keeps its row for up to an hour
// or so (entries.pruneExpired), so every query skips rows past expires_at.
const postgres = require("./index");

const LIVE = "(expires_at IS NULL OR expires_at > $2)";

// Each Redis list as [WHERE clause, score column]
const LISTS = {
  all: ["true", "created"],
  created: ["NOT deleted", "created"],
  entries: ["NOT (draft OR page OR menu OR scheduled OR deleted)", "date_stamp"],
  drafts: ["draft", "date_stamp"],
  scheduled: ["scheduled", "date_stamp"],
  pages: ["page", "date_stamp"],
  deleted: ["deleted", "deleted_at"],
};

// [{ id, score }] in the order ZRANGE returns them: by score, then by member
async function list(blogID, name, now = Date.now()) {
  const definition = LISTS[name];
  if (!definition) throw new Error("No list " + name);
  const [where, score] = definition;

  const { rows } = await postgres.query(
    `SELECT id, ${score} AS score FROM entries
     WHERE blog_id = $1 AND ${LIVE} AND ${where}
     ORDER BY ${score}, id COLLATE "C"`,
    [blogID, now]
  );

  return rows;
}

// The ids of the entries listed under a normalized tag, by date stamp
async function tagged(blogID, tag, now = Date.now()) {
  const { rows } = await postgres.query(
    `SELECT e.id FROM entry_tags t
     JOIN entries e USING (blog_id, path)
     WHERE t.blog_id = $1 AND (e.expires_at IS NULL OR e.expires_at > $2) AND t.tag = $3
     ORDER BY e.date_stamp, e.id COLLATE "C"`,
    [blogID, now, tag]
  );

  return rows.map((row) => row.id);
}

// Every normalized tag on the blog with its entry count and a spelling of it
async function tags(blogID, now = Date.now()) {
  const { rows } = await postgres.query(
    `SELECT t.tag, min(t.name) AS name, count(*)::int AS count FROM entry_tags t
     JOIN entries e USING (blog_id, path)
     WHERE t.blog_id = $1 AND (e.expires_at IS NULL OR e.expires_at > $2)
     GROUP BY t.tag ORDER BY t.tag`,
    [blogID, now]
  );

  return rows;
}

// The paths of the entries which depend on a file (a normalized, lowercased
// path, see models/entry/key.js dependents)
async function dependents(blogID, dependencyKey) {
  const { rows } = await postgres.query(
    `SELECT path FROM entry_dependencies WHERE blog_id = $1 AND dependency_key = $2 ORDER BY path`,
    [blogID, dependencyKey]
  );

  return rows.map((row) => row.path);
}

// Every dependency key on the blog with the paths which depend on it
async function dependencyGraph(blogID) {
  const { rows } = await postgres.query(
    `SELECT dependency_key, array_agg(path ORDER BY path) AS paths
     FROM entry_dependencies WHERE blog_id = $1 GROUP BY dependency_key`,
    [blogID]
  );

  return rows;
}

// The path of the entry at a URL, or null
async function byUrl(blogID, url, now = Date.now()) {
  const { rows } = await postgres.query(
    `SELECT path FROM entries WHERE blog_id = $1 AND ${LIVE} AND url = $3 AND url <> ''
     ORDER BY updated DESC LIMIT 1`,
    [blogID, now, url]
  );

  return rows.length ? rows[0].path : null;
}

module.exports = { LISTS, list, tagged, tags, dependents, dependencyGraph, byUrl };
