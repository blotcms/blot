const desnake = require("./desnake");
const FONTS = require("blog/static/fonts");
const specimen = require("blog/static/fonts/specimen");

module.exports = (key, value) => {
  return {
    key,
    options: FONTS.map(option => {
      return {
        tags: option.tags.map(i => {
          return { tag: i };
        }),
        tagsString: option.tags.join(" "),
        selected: value.id && option.id === value.id ? "selected" : "",
        name: option.name,
        ...specimen(option),
        stack: option.stack,
        id: option.id
      };
    }),
    font_size: value.font_size || 16,
    line_height: value.line_height || 1.4,
    value: (() => {
      const found = FONTS.find(({ id }) => id === value.id);
      return { ...(found || {}), ...specimen(found), ...value };
    })(),
    label: key ? desnake(key).replace(/ font$/i, "") : ""
  };
};
