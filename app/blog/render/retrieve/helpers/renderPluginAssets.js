const render = require("../../main");

// Plugin public JS/CSS (notably analytics/public.js) is a Mustache template
// over `plugins.*`. Templates include it with {{{appJS}}} / {{{appCSS}}}, which
// inserts the string as data and does not re-parse it. Render it here so
// provider sections and tracking IDs resolve without walking every local.
module.exports = function renderPluginAssets(source, req, res) {
  if (!source || typeof source !== "string" || source.indexOf("{{") === -1) {
    return source;
  }

  const locals = Object.assign(
    {},
    req && req.blog ? { plugins: req.blog.plugins } : {},
    (res && res.locals) || {}
  );
  const partials = (res && res.locals && res.locals.partials) || {};

  try {
    return render(source, locals, partials);
  } catch (e) {
    return source;
  }
};
