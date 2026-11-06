var fourOhFour = require("models/404");
var List = fourOhFour.list;

var MAX_SHOWN = 100;

// A visitor's request path, encoded for the Add redirect link's query string
// (the view escapes it for HTML; this keeps "&" or "#" in a path intact)
function withCreateParam(item) {
  return { ...item, createParam: encodeURIComponent(item.url) };
}

module.exports = function (req, res, next) {
  List(req.blog.id, function (err, list, ignored) {
    if (err) return next(err);

    var has_ignored;

    if (req.query.raw) {
      for (var i in list) list[i] = list[i].url;

      res.setHeader("Content-type", "text/plain");
      res.charset = "UTF-8";
      return res.send(list.join("\n"));
    }

    if (ignored.length) {
      has_ignored = true;
    }

    if (!req.query.ignored) {
      ignored = [];
    }

    // Most recent first; show only the latest 100
    res.locals.total = list.length.toLocaleString("en-US");
    res.locals.shown = Math.min(list.length, MAX_SHOWN).toLocaleString("en-US");
    res.locals.list = list.slice(0, MAX_SHOWN).map(withCreateParam);
    res.locals.has_ignored = has_ignored;
    res.locals.ignored = ignored.slice(0, MAX_SHOWN).map(withCreateParam);

    next();
  });
};
