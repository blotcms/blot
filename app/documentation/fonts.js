const Express = require("express");
const fonts = new Express.Router();
const config = require("config");
const Mustache = require("mustache");
const specimen = require("blog/static/fonts/specimen");

const FONTS = require("blog/static/fonts").map(font => {
  font.styles = Mustache.render(font.styles, {
    config: {
      cdn: { origin: config.cdn.origin }
    }
  });
  return { ...font, ...specimen(font) };
});

module.exports = function (req, res, next) {
  res.locals.fonts = FONTS;
  next();
};
