// The "Tag pages" control (load/tag-layouts.js) posts every tag's layout at
// once as `tag_layouts_json`, so this replaces `tag_layouts` outright rather
// than merging into it as prepareTemplateUpdate does with other objects, and
// a tag left out is removed. Only layouts the template lists are kept.
module.exports = function (req, res, next) {
  const submitted = req.body && req.body.tag_layouts_json;

  if (submitted === undefined) return next();

  const options = Array.isArray(req.locals.tag_layout_options)
    ? req.locals.tag_layout_options
    : [];

  let parsed;

  try {
    parsed = JSON.parse(submitted);
  } catch (err) {
    return next(new Error("The tag page layouts couldn't be read"));
  }

  const layouts = {};

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    for (const slug of Object.keys(parsed)) {
      const layout = parsed[slug];
      if (
        slug &&
        slug !== "__proto__" &&
        slug !== "constructor" &&
        slug !== "prototype" &&
        typeof layout === "string" &&
        options.includes(layout)
      )
        layouts[slug] = layout;
    }
  }

  req.locals.tag_layouts = layouts;
  next();
};
