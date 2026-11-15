require("models/template");
const Mustache = require("mustache");
const fs = require("fs-extra");
const { getMetadata } = require("../lib/models");
const { isRedisUnavailableError } = require("helper/redisUnavailable");
const { stackWithFallback } = require("blog/static/fonts/fallback");

// Stored font stacks end without a generic family or fonts for Arabic and
// Japanese. Add them as the template loads so existing sites get them
// without their template being saved again. Copies, in case metadata is shared.
function withFontFallbacks(locals) {
  const result = { ...locals };
  for (const key of Object.keys(result)) {
    if (key !== "font" && !key.includes("_font")) continue;
    const font = result[key];
    if (!font || typeof font !== "object" || !font.stack) continue;
    result[key] = { ...font, stack: stackWithFallback(font) };
  }
  return result;
}

module.exports = async function loadTemplate(req, res, next) {
  // We care about template metadata for template
  // locals. Stuff like page-size is set here.
  // Also global colors etc...
  if (!req.blog.template) return next();

  req.log("Loading template", req.blog.template);

  let metadata;

  try {
    metadata = await getMetadata(req.blog.template);
  } catch (err) {
    // An outage is not a missing template, and a 400 would be cached
    if (isRedisUnavailableError(err)) return next(err);

    const error = new Error("This template does not exist.");
    error.code = "NO_TEMPLATE";
    return next(error);
  }

  // If we're in preview mode and there are errors then let's show them
  if (
    req.preview &&
    metadata.errors &&
    Object.keys(metadata.errors).length > 0
  ) {
    const template = await fs.readFile(
      __dirname + "/../views/template-error.html",
      "utf-8"
    );

    const errors = Object.keys(metadata.errors).map((view) => {
      return { view, error: metadata.errors[view] };
    });

    const html = Mustache.render(template, {
      errors,
      name: metadata.name,
      path: metadata.localEditing ? "Templates/" + metadata.slug + "/" : "",
    });

    return res.status(400).send(html);
  }

  const template = {
    locals: withFontFallbacks(metadata.locals),
    id: req.blog.template,
    cacheID: metadata.cacheID,
    cdn: metadata.cdn || {},
  };

  req.template = template;

  req.log("Loaded template", req.blog.template);
  return next();
};
