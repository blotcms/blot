const { getPage } = require("../../lib/models");
const projectEntryFields = require("./helpers/projectEntryFields");
const asRetriever = require("../../lib/asRetriever");

async function latestEntry(req, res) {
  req.log("Loading latest entry");
  const { entries } = await getPage(req.blog.id, {
    pageNumber: 1,
    pageSize: 1,
  });
  req.log("Loaded latest entry");
  const latest = entries && entries.length ? entries[0] : {};
  return projectEntryFields(latest, req.retrieve, [
    "latestEntry",
    "latest_entry",
  ]);
};

module.exports = asRetriever(latestEntry);
