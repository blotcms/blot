// The catalog site's template. What matters is what each view makes the
// renderer load, so the comments say which local each part pulls and how:
// a list iterated through a partial gets no field projection, so every
// entry keeps its html and body.
const { rng, words } = require("./content");

function inline(seed, chars, line) {
  const random = rng(seed);
  let out = "";
  let n = 0;
  while (out.length < chars) out += line(n++, words(random, 6)) + "\n";
  return out.slice(0, chars);
}

function catalogViews(shape) {
  const style = inline(
    "style",
    shape.inlineStyleChars,
    (n, w) => `.c${n} { margin: ${n % 7}px; content: "${w}"; }`
  );
  const script = inline(
    "script",
    shape.inlineScriptChars,
    (n, w) => `window.s${n} = function () { return "${w}"; };`
  );

  return {
    // On every page. {{#archives}} through a partial: the whole catalog,
    // unprojected. Every tag, and two tags' entries.
    "head.html": `<head><title>{{title}}</title><style>{{> style.css}}</style></head>
<nav class="years">{{#archives}}{{> archive-year.html}}{{/archives}}</nav>
<nav class="tags">{{#all_tags}}<a href="/tagged/{{slug}}">{{name}}</a> {{/all_tags}}</nav>
<aside>{{#tagged.topic-1}}{{#entries}}<a href="{{{url}}}">{{title}}</a>{{/entries}}{{/tagged.topic-1}}
{{#tagged.topic-2}}{{#entries}}<a href="{{{url}}}">{{title}}</a>{{/entries}}{{/tagged.topic-2}}</aside>`,
    "archive-year.html": `<a href="/archives#{{year}}">{{year}}</a>`,

    // On every page: a client-side search index from {{#allEntries}}, which
    // projects to the fields it prints.
    "footer.html": `<footer>{{> search.html}}<script>{{> script.js}}</script></footer>`,
    "search.html": `<script>window.index = [{{#allEntries}}{"u":"{{{url}}}","p":"{{path}}","t":"{{title}}","d":{{dateStamp}},"a":"{{metadata.author}}","g":[{{#tags}}"{{.}}",{{/tags}}]},{{/allEntries}}];</script>`,

    "style.css": style,
    "script.js": script,
    "article.html": `<article><h2><a href="{{{url}}}">{{title}}</a></h2>{{{teaser}}}{{#tags}}<a href="/tagged/{{.}}">{{.}}</a>{{/tags}}</article>`,

    // The index also iterates {{#allEntries}} through a partial (unprojected)
    "entries.html": `<!DOCTYPE html><html>{{> head.html}}<body>
{{#posts}}{{> article.html}}{{/posts}}
<section class="all">{{#allEntries}}{{> entry-link.html}}{{/allEntries}}</section>
{{#pagination}}{{#next}}<a href="/page/{{next}}">Next</a>{{/next}}{{/pagination}}
{{> footer.html}}</body></html>`,
    "entry-link.html": `<a href="{{{url}}}">{{title}}</a>`,

    "entry.html": `<!DOCTYPE html><html>{{> head.html}}<body>
{{#entry}}<article>{{{html}}}{{#tags}}<a href="/tagged/{{.}}">{{.}}</a>{{/tags}}</article>{{/entry}}
{{> footer.html}}</body></html>`,

    "tagged.html": `<!DOCTYPE html><html>{{> head.html}}<body>
<h1>{{tag}}</h1>{{#entries}}{{> article.html}}{{/entries}}
{{> footer.html}}</body></html>`,

    "archives.html": `<!DOCTYPE html><html>{{> head.html}}<body>
{{#archives}}<h2 id="{{year}}">{{year}}</h2>{{#months}}<h3>{{month}}</h3>{{#entries}}<a href="{{{url}}}">{{title}}</a>{{/entries}}{{/months}}{{/archives}}
{{> footer.html}}</body></html>`,

    "error.html": `<!DOCTYPE html><html>{{> head.html}}<body><h1>{{error.title}}</h1>{{> footer.html}}</body></html>`,

    "sitemap.xml": `<?xml version="1.0" encoding="UTF-8"?><urlset>{{#allEntries}}<url><loc>{{{absoluteURL}}}</loc></url>{{/allEntries}}</urlset>`,
  };
}

// URLs for the views not routed by name
const VIEW_URLS = {
  "archives.html": "/archives",
  "sitemap.xml": "/sitemap.xml",
};

module.exports = { catalogViews, VIEW_URLS };
