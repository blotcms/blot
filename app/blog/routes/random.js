const { randomEntry } = require("../lib/models");

// Redirect to random article
module.exports = async function random(req, res, next) {
  try {
    // We preserve the query string for random in case
    // someone wants to get the entry JSON, or find the source
    const url = req.originalUrl;
    const queryIndex = url.indexOf("?");
    const queryString = queryIndex >= 0 ? url.slice(queryIndex) : "";

    const entry = await randomEntry(req.blog.id);
    if (!entry || !entry.url) return next();
    res.set("Cache-Control", "no-cache");
    res.redirect(entry.url + queryString);
  } catch (err) {
    return next(err);
  }
};
