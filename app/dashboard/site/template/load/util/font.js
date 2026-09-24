const desnake = require("./desnake");
const FONTS = require("blog/static/fonts");

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
        svg: option.svg,
        stack: option.stack,
        id: option.id
      };
    }),
    font_size: value.font_size || 16,
    line_height: value.line_height || 1.4,
    value: {
      ...(FONTS.find(({ id }) => id === value.id) || {}),
      ...value
    },
    label: key ? desnake(key).replace(/ font$/i, "") : ""
  };
};
