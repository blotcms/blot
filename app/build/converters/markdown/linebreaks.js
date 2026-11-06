// Format linebreaks to be compatible with markdown
module.exports = function (text) {
  if (!text) return text;

  const lines = text.split("\n");

  text = lines
    .map((line) => {
      if (!line || !line.trim()) return line;

      if (line.endsWith("  ")) return line;

      return line + "  ";
    })
    .join("\n");

  return text;
};
