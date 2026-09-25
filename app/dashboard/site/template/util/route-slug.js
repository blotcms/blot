const SITE_PREFIX = "site:";

// The URL segment that addresses a template id under /template/:templateSlug.
// SITE-owned templates always route through the "site:" prefix (see
// ../load/template.js) so they stay reachable by URL even once the blog has
// forked them — without it, a redirect built from a bare slug can collide
// with the blog's own fork of the same name and load (or highlight in the
// sidebar) the wrong one.
function routeSlugFromID(id) {
  const separator = id.indexOf(":");
  const owner = id.slice(0, separator);
  const slug = id.slice(separator + 1);
  return owner === "SITE" ? SITE_PREFIX + slug : slug;
}

module.exports = { SITE_PREFIX, routeSlugFromID };
