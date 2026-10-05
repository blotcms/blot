const ensure = require("helper/ensure");
const augment = require("./augment");
const backlinksFor = require("./backlinks");
const eachEntry = require("./eachEntry");

module.exports = async function loadView(req, res) {
  ensure(req, "object").and(res, "object");

  // Shared, so a page of entries linked from the same pages reads each once.
  const backlinks = backlinksFor(req);

  await eachEntry(res.locals, async (entry) => {
    await augment(req, res, entry, backlinks);
  });

  return { req, res };
};
