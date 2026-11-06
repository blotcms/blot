const desnake = require("./util/desnake");

module.exports = function (req, res, next) {
  res.locals.colors = Object.keys(req.template.locals)
    .filter((key) => key.indexOf("_color") > -1)
    .map((key) => {
      return { key, value: req.template.locals[key], label: desnake(key) };
    });

  return next();
};
