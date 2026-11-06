const time = require("helper/time");
const pandoc = require("build/converters/pandoc");
const debug = require("debug")("blot:converters:org");
const cheerio = require("cheerio");
const extractMetadata = require("build/metadata");
const loosenDisplayMath = require("build/math/loosenDisplayMath");

// Resolves to [html, metadata]
module.exports = async function (blog, text) {
  // Org always emits katex spans (see --katex below), so, as with the
  // markdown converter, display math ($$...$$) that occupies a whole
  // source line by itself but is glued to surrounding prose by a single
  // newline should still render as display rather than inline.
  try {
    text = loosenDisplayMath(text, { hardBreak: "\\\\" });
  } catch (e) {
    debug("loosenDisplayMath error", e.message || e.code, "caught safely");
  }

  debug("Pre-pandoc", text);
  time("pandoc");

  let output;

  try {
    output = await pandoc({ from: "org" }, Buffer.from(text, "utf8"));
  } finally {
    time.end("pandoc");
  }

  var result = output.html;

  const $ = cheerio.load(
    result,
    {
      decodeEntities: false,
      xmlMode: true,
    },
    false
  );

  // if there is a pre tag with class="yaml"
  // at the very start of the document then extract its contents,
  // replace the pre tag with the following:
  // ---
  // $YAML
  // ---

  // if the first child is a pre tag with class="yaml"
  const firstChild = $(":root").first();
  const yaml = firstChild && firstChild.is("pre.yaml") ? firstChild.text() : "";

  if (yaml) {
    firstChild.remove();
  }

  let combined =
    (yaml ? ["---", yaml.trim(), "---"].join("\n") : "") + $.html();

  const parsed = extractMetadata(combined);

  debug("Final:", parsed.html);
  return [parsed.html, parsed.metadata];
};
