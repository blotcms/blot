var config = require("config");

module.exports = function (req, res) {
  res.locals.layout = "sitemap.html";
  res.locals.protocol = req.protocol;
  res.locals.host = config.host;
  res.locals.urls = [
    "/",
    "/about",
    "/about/source-code",
    "/about/news",
    "/about/status",
    "/about/notes",
    "/how",
    "/how/pages",
    "/how/metadata",
    "/how/sync",
    "/how/posts",
    "/how/configure",
    "/sites/sign-up",
    "/sites/log-in",
    "/templates",
    "/developers",
    "/questions",
    "/contact",
    "/privacy",
    "/terms",
  ].map((i) => {
    return {
      url: config.protocol + config.host + i,
    };
  });
  res.setHeader("Content-Type", "text/xml");
  res.render("sitemap");
};
