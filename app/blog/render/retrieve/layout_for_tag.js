const asRetriever = require("../../lib/asRetriever");

// Which layout a tag page uses, chosen per tag in the template's settings:
//
//   "tag_layout": "rows",                      the default
//   "tag_layout_options": ["rows", "grid"],    the layouts the template has
//   "tag_layouts": { "photos": "grid" }        per tag, keyed by tag slug
//
// {{#layout_for_tag.grid}}...{{/layout_for_tag.grid}} then renders on
// /tagged/photos and wherever else the chosen layout is grid. On any other
// page, or for a tag with no entry, it is the default layout. A layout the
// template doesn't list in tag_layout_options is ignored, so a stale setting
// can't leave a tag page blank.

// Tag slugs are stored percent-encoded (helper/makeSlug); the route's param
// arrives decoded. Compare both decoded and lowercased.
function normalize(slug) {
  if (typeof slug !== "string") return "";
  try {
    slug = decodeURIComponent(slug);
  } catch (e) {
    // a stray % is left as it is
  }
  return slug.trim().toLowerCase();
}

function layoutForTag(locals, tag) {
  const options = Array.isArray(locals.tag_layout_options)
    ? locals.tag_layout_options
    : null;
  const allowed = (name) =>
    typeof name === "string" && name && (!options || options.includes(name));

  const fallback = allowed(locals.tag_layout)
    ? locals.tag_layout
    : (options && options[0]) || "rows";

  const layouts = locals.tag_layouts;
  if (!tag || !layouts || typeof layouts !== "object") return fallback;

  const wanted = normalize(tag);

  for (const slug of Object.keys(layouts)) {
    if (normalize(slug) === wanted && allowed(layouts[slug]))
      return layouts[slug];
  }

  return fallback;
}

module.exports = asRetriever(function (req, res) {
  const locals = (req.template && req.template.locals) || {};
  const tag =
    (req.params && req.params.tag) || (res && res.locals && res.locals.tag);

  return { [layoutForTag(locals, tag)]: true };
});

module.exports.layoutForTag = layoutForTag;
