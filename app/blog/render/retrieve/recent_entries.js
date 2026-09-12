const { getRecent } = require("../../lib/models");
const projectEntryFields = require("./helpers/projectEntryFields");
const entryFieldList = require("./helpers/entryFieldList");
const withEntryFields = require("../../lib/withEntryFields");
const asRetriever = require("../../lib/asRetriever");

async function recentEntries(req, res) {
  const keys = ["recentEntries", "recent_entries"];
  const fields = entryFieldList(req.retrieve, keys);

  let recent;
  if (!fields) {
    recent = await getRecent(req.blog.id);
  } else {
    recent = await withEntryFields(
      () => getRecent(req.blog.id, { fields }),
      () => getRecent(req.blog.id)
    );
  }

  return projectEntryFields(recent, req.retrieve, keys);
};

module.exports = asRetriever(recentEntries);
