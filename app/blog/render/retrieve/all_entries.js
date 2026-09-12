const { getAll } = require("../../lib/models");
const projectEntryFields = require("./helpers/projectEntryFields");
const asRetriever = require("../../lib/asRetriever");

async function allEntries(req, res) {
  const allEntriesList = await getAll(req.blog.id);

  return projectEntryFields(allEntriesList, req.retrieve, [
    "allEntries",
    "all_entries",
  ]);
};

module.exports = asRetriever(allEntries);
