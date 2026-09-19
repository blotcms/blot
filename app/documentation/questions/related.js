const { list } = require("models/question");

module.exports = async function related(req, res, next) {
  const path = require("url").parse(req.originalUrl).pathname;

  if (["/questions", "/questions/ask"].indexOf(path) > -1) return next();

  const related_tag = path.split("/").pop();

  res.locals.related_tag = related_tag;

  try {
    res.locals.related = await list({ tag: related_tag });
  } catch (err) {
    return next(err);
  }

  return next();
};
