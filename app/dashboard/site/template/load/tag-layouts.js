const Tags = require("models/tags");
const desnake = require("./util/desnake");

// The "Tag pages" control, for a template that lists its tag page layouts in
// `tag_layout_options` (see blog/render/retrieve/layout_for_tag.js): a select
// for the default layout (`tag_layout`) and one row per tag with its own
// layout (`tag_layouts`, keyed by tag slug). The rows are saved together as
// JSON by save/tag-layouts.js, so a tag can also be removed.
module.exports = async function (req, res, next) {
  try {
    const locals = req.template.locals || {};
    const options = locals.tag_layout_options;

    if (!Array.isArray(options) || !options.length) return next();

    const fallback = options.includes(locals.tag_layout)
      ? locals.tag_layout
      : options[0];

    const layoutOptions = (selected) =>
      options.map((value) => ({
        value,
        label: desnake(value),
        selected: value === selected ? "selected" : "",
      }));

    let tags = [];

    try {
      tags = await Tags.getCachedList(req.blog.id, {
        cacheID: req.blog.cacheID,
      });
    } catch (err) {
      // The control still works without the picker's suggestions
    }

    const names = {};
    tags.forEach((tag) => (names[tag.slug] = tag.name));

    const chosen =
      locals.tag_layouts && typeof locals.tag_layouts === "object"
        ? locals.tag_layouts
        : {};

    const rows = Object.keys(chosen).map((slug) => ({
      slug,
      name: names[slug] || decodeSlug(slug),
      options: layoutOptions(chosen[slug]),
    }));

    res.locals.tag_layouts_control = {
      default: {
        key: "tag_layout",
        label: "Default",
        showLabel: true,
        fullWidth: true,
        isSelect: true,
        value: fallback,
        options: layoutOptions(fallback),
      },
      rows,
      tags: tags
        .filter((tag) => !(tag.slug in chosen))
        .map((tag) => ({ slug: tag.slug, name: tag.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      options: layoutOptions(fallback),
      json: JSON.stringify(chosen),
    };

    next();
  } catch (err) {
    next(err);
  }
};

function decodeSlug(slug) {
  try {
    return decodeURIComponent(slug);
  } catch (e) {
    return slug;
  }
}
