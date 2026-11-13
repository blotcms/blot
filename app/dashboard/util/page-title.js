// Every dashboard page's <title> is its breadcrumb trail, read backwards,
// then Blot, all joined with " · ": "Reset · Sync · David · Blot". The
// leading Sites goes when there's more to say ("David · Blot"); a page with
// no trail keeps the title it renders with ("Create site · Blot").
const SEPARATOR = " · ";

module.exports = function (req, res, next) {
  const render = res.render;

  res.render = function (view, options, callback) {
    const opts = typeof options === "object" && options ? options : null;
    let parts = (res.locals.breadcrumbs || []).map((crumb) => crumb.label);

    if (parts.length > 1 && parts[0] === "Sites") parts = parts.slice(1);

    if (!parts.length) {
      const own = (opts && opts.title) || res.locals.title;
      if (own) parts = [own];
    }

    const title = parts.reverse().concat("Blot").join(SEPARATOR);

    res.locals.title = title;
    res.locals.hide_title_suffix = true;
    if (opts) {
      opts.title = title;
      opts.hide_title_suffix = true;
    }

    return render.call(this, view, options, callback);
  };

  next();
};
