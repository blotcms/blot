const { lookupEntryByUrl } = require("../../lib/models");

// Resolves entries' backlinks - the URLs of other entries that link to them,
// stored on each entry - into those entries, for augment().
//
// Each looked-up entry is a full one read from Redis, body included. Many
// entries on a blog often link to the same few pages, so looking each link up
// afresh for each entry reads and keeps a copy of the same target again and
// again - on a catalog-sized list, hundreds of MB. Resolutions made through
// one of these share a single read, and a single (frozen once cached) object,
// per URL: create one per walk over a list of entries.
//
// A lookup that fails (a Redis error, as opposed to a URL with no entry)
// resolves to nothing, same as a link to a missing entry. `failed` says whether
// that happened, so a caller about to cache the result can decline to -
// otherwise the gap would persist until the next cacheID change.
//
//   project (optional)  trims each looked-up entry before it is shared, e.g. to
//                       drop the html and body a template never reads from the
//                       entries it links to (retrieve/helpers/projectEntryFields)
//   enabled             false when no template can render backlinks (see
//                       isNeeded): they resolve to none, with no lookups
function createBacklinks(blogID, { project, enabled = true } = {}) {
  const lookups = new Map();
  let failed = false;

  function lookup(linkUrl) {
    if (!lookups.has(linkUrl)) {
      lookups.set(
        linkUrl,
        lookupEntryByUrl(blogID, linkUrl).then(({ entry, error }) => {
          if (error) failed = true;
          if (entry && project) project(entry);
          return entry;
        })
      );
    }

    return lookups.get(linkUrl);
  }

  return {
    get failed() {
      return failed;
    },

    // The entries linking to `entry`, once each, never itself or an
    // unpublished one.
    async resolve(entry) {
      const linkUrls = enabled && Array.isArray(entry.backlinks) ? entry.backlinks : [];

      const linked = await Promise.all(
        linkUrls.map((linkUrl) =>
          typeof linkUrl === "string" ? lookup(linkUrl) : null
        )
      );

      const seen = new Set();

      return linked.filter((other) => {
        if (!other || other.scheduled || other.path === entry.path) return false;
        if (seen.has(other.path)) return false;
        seen.add(other.path);
        return true;
      });
    },
  };
}

// For a request's view: render/middleware.js sets req.usesBacklinks from the
// view's template, which can't render backlinks if nothing in it, or in its
// partials, names them. An unset flag means "maybe".
function isNeeded(req) {
  return req.usesBacklinks !== false;
}

module.exports = function backlinksFor(req, options) {
  return createBacklinks(req.blog.id, { ...options, enabled: isNeeded(req) });
};

module.exports.isNeeded = isNeeded;
module.exports.createBacklinks = createBacklinks;
