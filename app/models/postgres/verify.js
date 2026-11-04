// Compares one blog's Postgres rows, and the Redis indexes rebuilt as
// queries (queries.js), against Redis.
//
// Two kinds of difference come back:
// - entries: a row which doesn't match the entry's JSON in Redis (or its tags
//   or dependencies don't match the ones derived from it). That is the
//   mirror's to fix: syncPaths(blogID, report.paths) does.
// - lists, tags, dependents, urls: a query which disagrees with the Redis
//   index while every row matches its entry. Either the index has drifted
//   from the entries (what Fix() repairs) or the query is wrong. Reads can't
//   move to a query until these are understood.
const _ = require("lodash");
const redis = require("models/client");
const postgres = require("./index");
const queries = require("./queries");
const { sanitize, rowsFor } = require("./entries");
const pathNormalize = require("helper/pathNormalizer");
const entryKeys = require("models/entry/key");
const entryKey = entryKeys.entry;
const tagKeys = require("models/tags/key");

const BATCH_SIZE = 25;
const SAMPLE_SIZE = 10;

function difference(name, redisSide, postgresSide, report) {
  const missing = [...redisSide].filter((item) => !postgresSide.has(item));
  const extra = [...postgresSide].filter((item) => !redisSide.has(item));
  if (missing.length || extra.length) {
    report.push({
      name,
      missing: missing.length,
      extra: extra.length,
      sample: missing.slice(0, SAMPLE_SIZE).concat(extra.slice(0, SAMPLE_SIZE)),
    });
  }
}

const COMPARED_COLUMNS = [
  "id", "guid", "url", "permalink", "title", "draft", "page", "menu",
  "scheduled", "deleted", "date_stamp", "created", "updated",
];

const pairs = (rows, ...columns) =>
  _.sortBy(rows.map((row) => columns.map((column) => row[column]).join("\n")));

// Compares one batch of paths, so a large blog is never held in memory at
// once. Not locked against live saves: a save between the two reads shows up
// as a difference, which a re-run (or --fix) clears.
async function compareBatch(blogID, paths, now, report, seen) {
  const [{ rows: entryRows }, { rows: tagRows }, { rows: dependencyRows }] = await Promise.all([
    postgres.query(
      `SELECT ${COMPARED_COLUMNS.join(", ")}, path, data FROM entries
       WHERE blog_id = $1 AND path = ANY($2::text[]) AND (expires_at IS NULL OR expires_at > $3)`,
      [blogID, paths, now]
    ),
    postgres.query(
      "SELECT path, tag, name FROM entry_tags WHERE blog_id = $1 AND path = ANY($2::text[])",
      [blogID, paths]
    ),
    postgres.query(
      "SELECT path, dependency_key, dependency FROM entry_dependencies WHERE blog_id = $1 AND path = ANY($2::text[])",
      [blogID, paths]
    ),
  ]);

  const rowsByPath = new Map(entryRows.map((row) => [row.path, row]));
  const tagsByPath = _.groupBy(tagRows, "path");
  const dependenciesByPath = _.groupBy(dependencyRows, "path");

  const multi = redis.multi();
  for (const path of paths) {
    multi.get(entryKey(blogID, path));
    multi.pTTL(entryKey(blogID, path));
  }
  const replies = await multi.exec();

  paths.forEach((path, i) => {
    const json = replies[i * 2];
    const row = rowsByPath.get(path);

    if (json) report.entries.redis++;
    if (row) {
      report.entries.postgres++;
      if (row.url) seen.urls.push([row.path, row.url]);
    }

    if (json && !row) return report.entries.missing.push(path);
    if (!json && row) return report.entries.extra.push(path);
    if (!json) return;

    seen.inRedis.add(path);

    const entry = JSON.parse(json);
    const expected = rowsFor(blogID, path, entry, { ttl: Number(replies[i * 2 + 1]), now });
    expected.dependencies.forEach((d) => seen.dependencyKeys.add(d.dependency_key));

    const same =
      _.isEqual(row.data, sanitize(entry)) &&
      COMPARED_COLUMNS.every((column) => row[column] === expected.entry[column]) &&
      _.isEqual(pairs(tagsByPath[path] || [], "tag", "name"), pairs(expected.tags, "tag", "name")) &&
      _.isEqual(
        pairs(dependenciesByPath[path] || [], "dependency_key", "dependency"),
        pairs(expected.dependencies, "dependency_key", "dependency")
      );

    if (!same) report.entries.different.push(path);
  });
}

async function verifyBlog(blogID) {
  const now = Date.now();
  const report = {
    blogID,
    entries: { redis: 0, postgres: 0, missing: [], extra: [], different: [] },
    indexes: [],
    // Paths to sync to fix the entry differences
    paths: [],
  };

  const listed = await redis.zRange("blog:" + blogID + ":all", 0, -1);
  const { rows } = await postgres.query("SELECT path FROM entries WHERE blog_id = $1", [blogID]);
  const paths = _.uniq(listed.map((id) => pathNormalize(id)).concat(rows.map((row) => row.path)));

  // What the index checks below need from the entries
  const seen = { inRedis: new Set(), dependencyKeys: new Set(), urls: [] };

  for (let i = 0; i < paths.length; i += BATCH_SIZE) {
    await compareBatch(blogID, paths.slice(i, i + BATCH_SIZE), now, report, seen);
  }

  report.paths = report.entries.missing.concat(report.entries.extra, report.entries.different);

  // Ids in a Redis list whose entry key is gone are left for Fix() and the
  // sweep (models/entries/sweepExpiredDeleted), not counted as differences
  const exists = (id) => seen.inRedis.has(pathNormalize(id));

  for (const name of Object.keys(queries.LISTS)) {
    const redisSide = await redis.zRangeWithScores("blog:" + blogID + ":" + name, 0, -1);
    const postgresSide = await queries.list(blogID, name, now);
    difference(
      "list " + name,
      new Set(redisSide.filter((item) => exists(item.value)).map((item) => item.value + " " + item.score)),
      new Set(postgresSide.map((item) => item.id + " " + item.score)),
      report.indexes
    );
  }

  const redisTags = await redis.sMembers(tagKeys.all(blogID));
  const postgresTags = await queries.tags(blogID, now);
  for (const tag of _.uniq(redisTags.concat(postgresTags.map((t) => t.tag)))) {
    const redisSide = await redis.zRange(tagKeys.sortedTag(blogID, tag), 0, -1);
    const postgresSide = await queries.tagged(blogID, tag, now);
    difference("tag " + tag, new Set(redisSide.filter(exists)), new Set(postgresSide), report.indexes);
  }

  const graph = await queries.dependencyGraph(blogID);
  const graphByKey = new Map(graph.map((g) => [g.dependency_key, g.paths]));
  for (const key of _.uniq([...seen.dependencyKeys, ...graphByKey.keys()])) {
    const members = await redis.sMembers(entryKeys.dependents(blogID, key));
    difference(
      "dependents " + key,
      new Set(members.map((path) => pathNormalize(path)).filter((path) => seen.inRedis.has(path))),
      new Set(graphByKey.get(key) || []),
      report.indexes
    );
  }

  for (let i = 0; i < seen.urls.length; i += BATCH_SIZE) {
    const batch = seen.urls.slice(i, i + BATCH_SIZE);
    const multi = redis.multi();
    for (const [, url] of batch) multi.get(entryKeys.url(blogID, url));
    const replies = await multi.exec();
    batch.forEach(([path, url], j) => {
      if ((replies[j] && pathNormalize(replies[j])) !== path) {
        report.indexes.push({
          name: "url " + url,
          missing: 0,
          extra: 1,
          sample: [path + " (Redis: " + replies[j] + ")"],
        });
      }
    });
  }

  report.ok = !report.paths.length && !report.indexes.length;
  return report;
}

module.exports = verifyBlog;
