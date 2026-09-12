const { getAll } = require("../../lib/models");
const projectEntryFields = require("./helpers/projectEntryFields");
const entryFieldList = require("./helpers/entryFieldList");
const withEntryFields = require("../../lib/withEntryFields");
const asRetriever = require("../../lib/asRetriever");
const { MAX_ENTRIES } = require("../../lib/limits");

async function allEntries(req, res) {
  const keys = ["allEntries", "all_entries"];
  const fields = entryFieldList(req.retrieve, keys);

  let allEntriesList;
  if (!fields) {
    allEntriesList = await getAll(req.blog.id, { limit: MAX_ENTRIES });
  } else {
    allEntriesList = await withEntryFields(
      () => getAll(req.blog.id, { fields, limit: MAX_ENTRIES }),
      () => getAll(req.blog.id, { limit: MAX_ENTRIES })
    );
  }

  return projectEntryFields(allEntriesList, req.retrieve, keys);
};

module.exports = asRetriever(allEntries);
