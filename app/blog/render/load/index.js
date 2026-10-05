const ensure = require("helper/ensure");
const augment = require("./augment");
const backlinksFor = require("./backlinks");
const eachEntry = require("./eachEntry");

module.exports = async function loadView(req, res) {
  ensure(req, "object").and(res, "object");

  // Shared, so a page of entries linked from the same pages reads each once.
  const backlinks = backlinksFor(req);

  let total = 0;

  req.log("Augmenting entries");

  await eachEntry(res.locals, async (entry) => {
    total++;
    await augment(req, res, entry, backlinks);
  });

  req.log("Augmented", total, "entries");

  return { req, res };
};
