module.exports = function (req, res, next) {
  // ua can sometimes be undefined
  const ua = req.get("User-Agent") || "";

  // This is used to auto-crawl links in Outlook
  // and renders the one-time code unusable. We could
  // work around this but for now, let's do this.
  if (ua.indexOf("BingPreview") === -1) {
    return next();
  }

  res.status(403);
  res.send("Forbidden: link must be clicked by user, not crawled by bot");
};
