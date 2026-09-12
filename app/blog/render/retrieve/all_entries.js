const { getAll } = require("../../lib/models");
const projectEntryFields = require("./helpers/projectEntryFields");
const entryFieldList = require("./helpers/entryFieldList");
const withEntryFields = require("../../lib/withEntryFields");
const asRetriever = require("../../lib/asRetriever");

async function allEntries(req, res) {
  const keys = ["allEntries", "all_entries"];
  const fields = entryFieldList(req.retrieve, keys);

  let allEntriesList;
  if (!fields) {
    allEntriesList = await getAll(req.blog.id);
  } else {
    allEntriesList = await withEntryFields(
      () => getAll(req.blog.id, { fields }),
      () => getAll(req.blog.id)
    );
  }

  return projectEntryFields(allEntriesList, req.retrieve, keys);
};

module.exports = asRetriever(allEntries);
