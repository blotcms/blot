const desnake = require("./util/desnake");

module.exports = function imageInputs(req, res, next) {
  const locals = req.template.locals || {};
  res.locals.images = Object.keys(locals)
    .filter((key) => key.endsWith("_image"))
    .map((key) => ({
      key,
      value: locals[key] && locals[key].url ? locals[key] : null,
      label: desnake(key.slice(0, -"_image".length)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  next();
};
