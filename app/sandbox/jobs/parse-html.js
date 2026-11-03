// Parses HTML that came from a remote source (a post the importer read from
// an Are.na block or an export) in the jail, so Node never does. The input is
// the HTML as UTF-8; args.op names one fixed operation (./html.js):
//
//   scan      { op, kind } kind is "images", "pdfs" or "audio". meta.urls is the
//             http(s) URLs of that kind in the post, each once, and outputs[0]
//             the HTML as the parser writes it back.
//   rewrite   { op, kind, replacements: [[url, name], ...] } outputs[0] is the
//             HTML with each URL changed to its name.
//   markdown  { op } outputs[0] is the HTML as Markdown.
//
// Markup that is too large, has too many tags or is nested too deeply is
// `meta.error`, not a failure of the job.

const html = require("./html");

const OPS = ["scan", "rewrite", "markdown"];

async function run(args, input) {
  args = args && typeof args === "object" ? args : {};
  if (!OPS.includes(args.op)) return { meta: { error: "unknown operation" }, outputs: [] };

  try {
    const text = input.toString("utf8");

    if (args.op === "scan") {
      const { urls, html: normalized } = html.scan(args.kind, text);
      return { meta: { urls }, outputs: [Buffer.from(normalized)] };
    }
    if (args.op === "rewrite") {
      return { meta: {}, outputs: [Buffer.from(html.rewrite(args.kind, text, args.replacements))] };
    }
    return { meta: {}, outputs: [Buffer.from(html.markdown(text))] };
  } catch (err) {
    if (err instanceof html.MarkupError) return { meta: { error: err.message }, outputs: [] };
    throw err;
  }
}

module.exports = { run, OPS };
