const config = require("config");

// These converters do not require any external
// software (i.e. pandoc) to function
let converters = [
  require("./html"),
  require("./img"),
  require("./webloc"),
  require("./gdoc"),
];

if (config.pandoc.bin) {
  converters.push(require("./docx"));
  converters.push(require("./rtf"));
  converters.push(require("./odt"));
  converters.push(require("./org"));
  converters.push(require("./markdown"));
} else {
  converters.push(require("./markdown-without-pandoc"));
}

module.exports = converters;

converters.forEach(function (converter) {
  if (!converter.id || typeof converter.id !== "string") {
    throw new Error("Converter missing stable id");
  }
});
