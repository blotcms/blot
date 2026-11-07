const promiseOnly = require("helper/promiseOnly");
const client = require("models/client");
const pathIndex = require("models/entries/pathIndex");

module.exports = promiseOnly(async function entriesPathIndex(blog) {
  const entriesKey = "blog:" + blog.id + ":entries";
  const lexKey = pathIndex.lexKey(blog.id);

  const [entriesCountResult, lexCountResult] = await Promise.all([
    client.zCard(entriesKey),
    client.zCard(lexKey),
  ]);

  const entriesCount = parseInt(entriesCountResult, 10) || 0;
  const lexCount = parseInt(lexCountResult, 10) || 0;

  if (entriesCount === lexCount) return [];

  const rebuiltCount = await pathIndex.backfillIndex(blog.id);

  return [
    ["MISMATCH", { entries: entriesCount, pathIndex: lexCount }],
    ["BACKFILLED", rebuiltCount],
  ];
});
