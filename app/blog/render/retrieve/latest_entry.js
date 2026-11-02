const { getPage } = require("../../lib/models");
const projectEntryFields = require("./helpers/projectEntryFields");
const asRetriever = require("../../lib/asRetriever");

const ALIASES = ["latest_entry"];

// A page of one entry (a ZRANGE, a ZCARD and one GET), so not worth a cache
async function latestEntry(req, res) {
  const log = typeof req?.log === "function" ? req.log.bind(req) : () => {};

  log("Loading latest entry");
  const { entries } = await getPage(req.blog.id, { pageNumber: 1, pageSize: 1 });
  log("Loaded latest entry");
  const latest = entries && entries.length ? entries[0] : {};

  return projectEntryFields(latest, req.retrieve, ALIASES);
}

module.exports = asRetriever(latestEntry);
