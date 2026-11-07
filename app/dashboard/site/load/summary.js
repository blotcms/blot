const loadLiveTemplate = require("./live-template");
const { domainLocals } = require("../domain");

// Everything the summary card (site/site-summary.html) shows: the live
// template's name and link, and what its Domain row opens to
module.exports = function (req, res, next) {
  domainLocals(req, res);
  return loadLiveTemplate(req, res, next);
};
