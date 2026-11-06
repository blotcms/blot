// The importer's parsing of a post's HTML, which is done in the sandbox's
// parse-html job (app/sandbox/jobs/html.js), not in Node: a post's HTML comes
// from a remote source (an Are.na block) or from an export, and the importer
// used to hand it to cheerio and turndown itself. What comes back is plain
// data: the URLs to download, HTML the parser wrote, Markdown.
//
//   const { urls, html } = await htmlAssets.scan("images", post.html);
//   post.html = await htmlAssets.rewrite("images", post.html, [[url, name]]);
//   post.content = await htmlAssets.markdown(post.html);
//
// kind is "images", "pdfs" or "audio". Markup the job refuses (too large, too
// many tags, nested too deeply) rejects with an Error whose message says so, and
// the stage fails the post, as any bad post does.

const sandbox = require("sandbox");
const lifecycle = require("../lifecycle");

async function run(args, html) {
  lifecycle.check();
  if (typeof html !== "string") throw new Error("The post has no HTML");

  const { meta, outputs } = await sandbox.run(
    "parse-html",
    args,
    Buffer.from(html)
  );
  lifecycle.check();

  if (!meta || typeof meta !== "object")
    throw new Error("parse-html: invalid answer");
  if (meta.error)
    throw new Error(
      "Could not read the post's HTML: " + String(meta.error).slice(0, 100)
    );
  if (outputs.length !== 1) throw new Error("parse-html: invalid answer");
  return { meta, output: outputs[0].toString("utf8") };
}

// The http(s) URLs of one kind in the post, each once, and the HTML as the
// parser writes it back
async function scan(kind, html) {
  const { meta, output } = await run({ op: "scan", kind }, html);
  if (
    !Array.isArray(meta.urls) ||
    !meta.urls.every((url) => typeof url === "string")
  ) {
    throw new Error("parse-html: invalid answer");
  }
  return { urls: meta.urls, html: output };
}

// The post's HTML with each [url, name] pair applied
async function rewrite(kind, html, replacements) {
  return (await run({ op: "rewrite", kind, replacements }, html)).output;
}

async function markdown(html) {
  return (await run({ op: "markdown" }, html)).output;
}

module.exports = { scan, rewrite, markdown };
