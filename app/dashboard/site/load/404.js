var fourOhFour = require("models/404");
var List = fourOhFour.list;

module.exports = async function (req, res, next) {
  try {
    var { list, ignored } = await List(req.blog.id);

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

    res.locals.list = list;
    res.locals.has_ignored = has_ignored;
    res.locals.ignored = ignored;

    next();
  } catch (err) {
    next(err);
  }
};
