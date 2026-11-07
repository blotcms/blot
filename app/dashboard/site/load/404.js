var fourOhFour = require("models/404");
var List = fourOhFour.list;

var MAX_SHOWN = 100;

// A visitor's request path, encoded for the Add redirect link's query string
// (the view escapes it for HTML; this keeps "&" or "#" in a path intact)
function withCreateParam(item) {
  return { ...item, createParam: encodeURIComponent(item.url) };
}

module.exports = async function (req, res, next) {
  try {
    // The raw list is every path; the page formats only the latest 100
    var options = req.query.raw ? {} : { limit: MAX_SHOWN };

    var [list, ignored, totals] = await new Promise((resolve, reject) => {
      List(req.blog.id, options, (err, list, ignored, totals) => {
        if (err) return reject(err);
        resolve([list, ignored, totals]);
      });
    });

    var has_ignored;

    if (req.query.raw) {
      for (var i in list) list[i] = list[i].url;

      res.setHeader("Content-type", "text/plain");
      res.charset = "UTF-8";
      return res.send(list.join("\n"));
    }

    if (totals.ignored) {
      has_ignored = true;
    }

    if (!req.query.ignored) {
      ignored = [];
    }

    // Most recent first, the latest 100 of each
    res.locals.total = totals.list.toLocaleString("en-US");
    res.locals.shown = list.length.toLocaleString("en-US");
    res.locals.list = list.map(withCreateParam);
    res.locals.has_ignored = has_ignored;
    res.locals.ignored = ignored.map(withCreateParam);

    next();
  } catch (err) {
    next(err);
  }
};
