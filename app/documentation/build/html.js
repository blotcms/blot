const cheerio = require("cheerio");

module.exports = async (contents) => {
  const transformers = [
    require("../tools/hljs"),
    require("../tools/typeset"),
    require("../tools/anchor-links"),
    require("../tools/tex"),
    require("../tools/finder").html_parser,
  ];

  // we want to remove any indentation before the partial tag {{> body}}

  if (contents.includes("{{> body}}")) {
    const lines = contents.split("\n");
    const result = lines
      .map((i) => {
        if (!i.includes("{{> body}}")) return i;
        if (i.trim().startsWith("{{> body}}")) return i.trim();
      })
      .join("\n");

    return result;
  }

  const $ = cheerio.load(contents, { decodeEntities: false }, false);

  for (const transformer of transformers) {
    transformer($);
  }

  let result = $.html();

  // replace all the escaped partial tags with the actual partial tags
  if (result.includes("{{&gt; ")) {
    result = result.replace(/{{&gt; /g, "{{> ");
  }

  // remove the indent from the line which contains the body partial
  // this prevents issues with code snippets
  if (result.includes("{{> body}}")) {
    const lines = result.split("\n");
    const index = lines.findIndex((line) => line.includes("{{> body}}"));
    lines[index] = lines[index].trim();
    result = lines.join("\n");
  }

  return result;
};
