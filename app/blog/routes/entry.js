const normalize = require("helper/urlNormalizer");
const metadataCaseInsensitive = require("helper/metadataCaseInsensitive");
const { getEntryByUrl } = require("../lib/models");
const attachAdjacent = require("../lib/attachAdjacent");
const loadPlugin = require("../lib/loadPlugin");

const normalizeMetadataToggle = function (value) {
  if (typeof value === "undefined" || value === null) return "";
  return String(value).trim().toLowerCase();
};

module.exports = async function entry(req, res, next) {
  req.log("Loading entry");

  try {
    const scheduled = !!req.query.scheduled;
    const blog = req.blog;

    // we use req.path as opposed to req.url
    // because we don't care about the query string.
    // perhaps entry.getByUrl should be responsible
    // for stripping the query string?
    let url = req.path;

    // remove trailing slash
    if (url.slice(-1) === "/") url = url.slice(0, -1);

    // add leading slash
    if (url[0] !== "/") url = "/" + url;

    // Keep path shaping local (slashes + lowercase) but let Entry.getByUrl
    // handle URI decoding so all URL-decoding behavior is centralized there.
    url = url.toLowerCase();

    const entry = await getEntryByUrl(blog.id, url);
    if (!entry || entry.deleted || entry.draft) return next();

    // If comments are enabled in settings, they are shown on all blog posts and pages
    // Disable comments in cases:
    // 1. Blog post metadata DOES have  'Comments: No'
    // 2. Page metadata DOES NOT have   'Comments: Yes'
    const metadataByLowercaseKey = metadataCaseInsensitive(entry.metadata);
    entry.metadataLowercase = metadataByLowercaseKey;
    const commentsToggle = normalizeMetadataToggle(
      metadataByLowercaseKey.comments
    );

    if (commentsToggle === "no" || (commentsToggle !== "yes" && entry.page)) {
      delete blog.plugins.disqus;
      delete blog.plugins.blueskyComments;
    }

    // Redirect this entry to the file from which it was generated
    // I use this when debugging user blogs.
    if (
      entry.path &&
      req.query &&
      req.query.source &&
      req.query.source === "true"
    )
      return res.redirect(entry.path);

    if (entry.scheduled && !scheduled) return next();

    // We check if the url is not the site's index page
    // since it's possible to accidentally set an entry's
    // permalink to this, then never be able to undo it
    // otherwise. Thanks to Jack for discovering this fun bug.
    // We really should check that this URL is not used by
    // any of the template views but will do that in future.
    let comparableUrl = url;

    // Canonical comparison should use a decoded form when possible so
    // encoded and plain unicode request paths are treated the same.
    try {
      comparableUrl = decodeURI(comparableUrl);
    } catch (e) {
      // keep encoded form if malformed
    }

    if (
      normalize(entry.url) !== normalize(comparableUrl) &&
      comparableUrl === "/"
    )
      return next();

    await attachAdjacent(blog.id, entry);

    // Ensure the user is always viewing
    // the entry at its latest and greatest URL
    // 301 passes link juice for SEO?
    if (entry.url && normalize(entry.url) !== normalize(comparableUrl)) {
      // Res.direct expects a URL, we shouldnt need
      // to do this now but OK. I feel like we're decoding
      // then recoding then decoding. I should just store
      // valid URI and skip the decoding.
      const redirect = encodeURI(entry.url);

      return res.status(301).redirect(redirect);
    }

    let pluginHTML = await loadPlugin("entryHTML", blog.plugins);

    // Dont show plugin HTML on a draft.
    // Don't show plugin HTML on a preview subdomain.
    // This is to prevent Disqus getting stuck on one URL.
    if (entry.draft || req.preview) {
      pluginHTML = pluginHTML
        ? "<p><em>Comments are hidden on site previews.</em></p>"
        : "";
    }

    res.locals.partials.pluginHTML = pluginHTML;
    res.locals.entry = entry;

    req.log("Loaded entry");
    res.renderView("entry.html", next);
  } catch (err) {
    return next(err);
  }
};
