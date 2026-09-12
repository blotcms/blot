const { getRecent } = require("../../lib/models");
const projectEntryFields = require("./helpers/projectEntryFields");
const asRetriever = require("../../lib/asRetriever");

async function recentEntries(req, res) {
  const recent = await getRecent(req.blog.id);

  return projectEntryFields(recent, req.retrieve, [
    "recentEntries",
    "recent_entries",
  ]);
};

module.exports = asRetriever(recentEntries);
