const desnake = require("./desnake");
const FONTS = require("blog/static/fonts");
const specimen = require("blog/static/fonts/specimen");

// A template's stored font setting is only trusted for its id and two
// numbers: a template shared by someone else keeps its settings, and the
// editor prints the font's CSS, stack and specimen address as markup. Those
// come from Blot's own font list, looked up by id.
const number = (value, fallback) => {
  const parsed = parseFloat(value);
  return isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

module.exports = (key, value) => {
  value = value || {};
  const fontSize = number(value.font_size, 16);
  const lineHeight = number(value.line_height, 1.4);
  return {
    key,
    options: FONTS.map((option) => {
      return {
        tags: option.tags.map((i) => {
          return { tag: i };
        }),
        tagsString: option.tags.join(" "),
        selected: value.id && option.id === value.id ? "selected" : "",
        name: option.name,
        ...specimen(option),
        stack: option.stack,
        id: option.id,
      };
    }),
    font_size: fontSize,
    stepper: {
      id: `locals.${key}.font_size`,
      label:
        `${key ? desnake(key).replace(/ font$/i, "") : ""} font size`.trim(),
      ariaLabel: `${key ? desnake(key).replace(/ font$/i, "") : ""} font size`,
      value: fontSize,
      min: 9,
      max: 96,
    },
    line_height: lineHeight,
    value: (() => {
      const found = FONTS.find(({ id }) => id === value.id);
      return {
        ...(found || {}),
        ...specimen(found),
        font_size: fontSize,
        line_height: lineHeight,
      };
    })(),
    label: key ? desnake(key).replace(/ font$/i, "") : "",
  };
};
