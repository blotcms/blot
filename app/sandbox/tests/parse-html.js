describe("sandbox parse-html job", function () {
  const cheerio = require("cheerio");
  const config = require("config");
  const sandbox = require("../");
  const html = require("../jobs/html");

  let socket;

  beforeEach(function () {
    // no broker: the job runs in-process
    socket = config.sandbox.socket;
    config.sandbox.socket = "";
  });

  afterEach(function () {
    config.sandbox.socket = socket;
  });

  const run = (args, input) =>
    sandbox.run("parse-html", args, Buffer.from(input));
  const scan = (kind, input) => run({ op: "scan", kind }, input);
  const rewrite = (kind, input, replacements) =>
    run({ op: "rewrite", kind, replacements }, input);
  const markdown = (input) => run({ op: "markdown" }, input);

  // What the importer's stages used to do in Node, to hold the job to
  const parseAsBefore = (input) =>
    cheerio.load(input, { decodeEntities: false });

  describe("scan", function () {
    it("lists a post's images once each, in order, and the HTML as the parser writes it", async function () {
      const post =
        '<p><img src="https://example.com/a.png"><img src="https://example.com/b.png">' +
        '<img src="https://example.com/a.png"><img src="data:image/png;base64,AAAA"><img src="/relative.png">' +
        '<img><img src=""><img src="ftp://example.com/c.png"><img src="javascript:alert(1)"></p>';

      const { meta, outputs } = await scan("images", post);

      expect(meta.urls).toEqual([
        "https://example.com/a.png",
        "https://example.com/b.png",
      ]);
      expect(outputs[0].toString()).toBe(parseAsBefore(post).html());
    });

    it("lists a post's PDFs: http(s) links whose whole address ends in .pdf", async function () {
      const post =
        '<a href="https://example.com/a.pdf">a</a><a href="http://example.com/b.pdf">b</a>' +
        '<a href="https://example.com/c.pdf?x=1">c</a><a href="https://example.com/d.PDF">d</a>' +
        '<a href="/e.pdf">e</a><a href="https://example.com/f.html">f</a><a>g</a>' +
        '<a href="https://example.com/a.pdf">again</a>';

      const { meta } = await scan("pdfs", post);

      expect(meta.urls).toEqual([
        "https://example.com/a.pdf",
        "http://example.com/b.pdf",
      ]);
    });

    it("lists a post's audio", async function () {
      const post =
        '<audio src="https://example.com/a.mp3"></audio><audio src="//example.com/b.mp3"></audio>' +
        '<audio><source src="https://example.com/c.mp3"></audio><audio src="data:audio/mp3;base64,AAAA"></audio>';

      const { meta } = await scan("audio", post);

      expect(meta.urls).toEqual(["https://example.com/a.mp3"]);
    });

    it("leaves out an address longer than the fetch job takes", async function () {
      const long = "https://example.com/" + "a".repeat(html.MAX_URL_LENGTH);
      const { meta } = await scan(
        "images",
        `<img src="${long}"><img src="https://example.com/ok.png">`
      );
      expect(meta.urls).toEqual(["https://example.com/ok.png"]);
    });

    it("lists at most MAX_URLS addresses", async function () {
      const post = Array.from(
        { length: html.MAX_URLS + 500 },
        (_, i) => `<img src="https://example.com/${i}.png">`
      ).join("");
      const { meta } = await scan("images", post);
      expect(meta.urls.length).toBe(html.MAX_URLS);
      expect(meta.urls[0]).toBe("https://example.com/0.png");
    });

    it("writes the HTML back exactly as cheerio did for the importers", async function () {
      const posts = [
        "",
        "plain text & <b>bold</b>",
        "<p>unclosed <b>bold <i>italic<p>next &nbsp; &amp; &lt;script&gt;",
        "<table><tr><td>cell<td>cell</table><ul><li>one<li>two</ul>",
        '<div><a href="https://example.com/x.pdf?a=1&b=2">x &copy;</a><script>if (a < b) { x = "</p>"; }</script></div>',
        "<!DOCTYPE html><html><head><title>t</title></head><body><!-- c --><p>é ü 日本語</p></body></html>",
        "<form><form><input name=a></form></form><noscript><img src=x></noscript><template><p>t</template>",
      ];
      for (const post of posts) {
        const { outputs } = await scan("images", post);
        expect(outputs[0].toString()).toBe(parseAsBefore(post).html());
      }
    });

    it("does not count a tag-like quoted value as markup", async function () {
      const quoted =
        '<a title="' +
        "<b ".repeat(html.MAX_TAGS * 2) +
        '" href="https://example.com/a.pdf">a</a>';
      const { meta } = await scan("pdfs", quoted);
      expect(meta.urls).toEqual(["https://example.com/a.pdf"]);
    });
  });

  describe("rewrite", function () {
    // The stages' old code, as it ran on a cheerio document
    function rewriteAsBefore(kind, input, replacements) {
      const $ = parseAsBefore(input);
      const map = new Map(replacements);
      const tag = { images: "img", pdfs: "a", audio: "audio" }[kind];
      const attribute = kind === "pdfs" ? "href" : "src";
      $(tag).each((i, el) => {
        const value = $(el).attr(attribute);
        if (!map.has(value)) return;
        const name = map.get(value);
        if (kind === "pdfs" && $(el).text() === value) $(el).text(name);
        $(el).attr(attribute, name);
        if (kind === "images" && $(el).parent().attr("href") === value)
          $(el).parent().attr("href", name);
      });
      return $.html();
    }

    it("changes the src of a downloaded image, and a link around it to the same address", async function () {
      const post =
        '<a href="https://example.com/a.png"><img src="https://example.com/a.png"></a>' +
        '<a href="https://example.com/page"><img src="https://example.com/a.png"></a>' +
        '<a href="https://example.com/a.png"><img src="https://example.com/a.png"><img src="https://example.com/a.png"></a>' +
        '<img src="https://example.com/b.png"><img src="data:image/png;base64,AAAA">';
      const replacements = [["https://example.com/a.png", "_a.png"]];

      const { outputs } = await rewrite("images", post, replacements);
      const result = outputs[0].toString();

      expect(result).toBe(rewriteAsBefore("images", post, replacements));
      expect(result).toContain('<a href="_a.png"><img src="_a.png"></a>');
      expect(result).toContain(
        '<a href="https://example.com/page"><img src="_a.png"></a>'
      );
      expect(result).toContain('src="https://example.com/b.png"');
      expect(result).toContain('src="data:image/png;base64,AAAA"');
    });

    it("changes the href of a downloaded PDF, and its text if that was the address", async function () {
      const post =
        '<a href="https://example.com/a.pdf">https://example.com/a.pdf</a>' +
        '<a href="https://example.com/a.pdf">the paper</a><a href="https://example.com/b.pdf">b</a>';
      const replacements = [["https://example.com/a.pdf", "_a.pdf"]];

      const { outputs } = await rewrite("pdfs", post, replacements);
      const result = outputs[0].toString();

      expect(result).toBe(rewriteAsBefore("pdfs", post, replacements));
      expect(result).toContain('<a href="_a.pdf">_a.pdf</a>');
      expect(result).toContain('<a href="_a.pdf">the paper</a>');
      expect(result).toContain('<a href="https://example.com/b.pdf">b</a>');
    });

    it("changes the src of downloaded audio", async function () {
      const post =
        '<audio src="https://example.com/a.mp3"></audio><audio src="https://example.com/b.mp3"></audio>';
      const replacements = [["https://example.com/a.mp3", "_a.mp3"]];

      const { outputs } = await rewrite("audio", post, replacements);

      expect(outputs[0].toString()).toBe(
        rewriteAsBefore("audio", post, replacements)
      );
      expect(outputs[0].toString()).toContain('<audio src="_a.mp3">');
    });

    it("keeps a replacement's name as text, never as markup", async function () {
      const post = '<img src="https://example.com/a.png">';
      const name = '_"><script>alert(1)</script>.png';

      const { outputs } = await rewrite("images", post, [
        ["https://example.com/a.png", name],
      ]);

      const $ = cheerio.load(outputs[0].toString());
      expect($("script").length).toBe(0);
      expect($("img").attr("src")).toBe(name);
    });

    it("refuses replacements that are not a short list of an address and a name", async function () {
      const post = '<img src="https://example.com/a.png">';
      const bad = [
        "x",
        [["https://example.com/a.png"]],
        [["https://example.com/a.png", ""]],
        [["https://example.com/a.png", 5]],
        [["https://example.com/a.png", "n".repeat(600)]],
        [["javascript:alert(1)", "_a.png"]],
        [["/relative.png", "_a.png"]],
        Array.from({ length: html.MAX_URLS + 1 }, (_, i) => [
          `https://example.com/${i}.png`,
          "_a.png",
        ]),
      ];
      for (const replacements of bad) {
        const { meta, outputs } = await rewrite("images", post, replacements);
        expect(meta.error).toBe("invalid replacements");
        expect(outputs).toEqual([]);
      }
    });
  });

  describe("markdown", function () {
    // convert_to_markdown.js as it was when Node ran Turndown itself
    function markdownAsBefore(input) {
      const Turndown = require("turndown");
      const turndown = new Turndown({
        bulletListMarker: "-",
        codeBlockStyle: "fenced",
        emDelimiter: "*",
      });
      turndown.use(require("turndown-plugin-gfm").gfm);
      turndown.escape = (text) => text;
      turndown.keep(["audio", "video", "iframe"]);
      return turndown.turndown(input).trim();
    }

    it("converts HTML as the importers' Turndown did", async function () {
      const posts = [
        "<h1>Title</h1><p>Some <strong>bold</strong> and <em>emphasis</em> with a <a href='https://example.com'>link</a>.</p><ul><li>one</li><li>two</li></ul><pre><code>code</code></pre>",
        "<p>_not_ *escaped* `ticks` # hash 1. one</p><blockquote><p>quote</p></blockquote><hr><img src='a.png' alt='A'>",
        "<p>unclosed <b>bold <i>italic<p>next &amp; &lt;tag&gt; &nbsp; é 日本語",
        "<html><head></head><body><p>wrapped</p></body></html>",
        "<ol><li>a<ul><li>b</li></ul></li></ol><del>gone</del><table><tr><td>x</td></tr></table>",
        "plain text only",
        "",
      ];
      for (const post of posts) {
        const { meta, outputs } = await markdown(post);
        expect(meta.error).toBeUndefined();
        expect(outputs[0].toString()).toBe(markdownAsBefore(post));
      }

      const { outputs } = await markdown(posts[0]);
      expect(outputs[0].toString()).toBe(
        "Title\n=====\n\nSome **bold** and *emphasis* with a [link](https://example.com).\n\n-   one\n-   two\n\n```\ncode\n```"
      );
    });

    it("leaves Markdown inside the HTML alone, and keeps audio, video and iframes", async function () {
      const { outputs } = await markdown(
        '<p>_Hey_ and *you* and [a](b)</p><audio src="a.mp3"></audio><iframe src="https://example.com/embed"></iframe>'
      );
      const text = outputs[0].toString();

      expect(text).toContain("_Hey_ and *you* and [a](b)");
      expect(text).toContain('<audio src="a.mp3"></audio>');
      expect(text).toContain(
        '<iframe src="https://example.com/embed"></iframe>'
      );
    });

    it("converts tables, as GitHub flavoured Markdown", async function () {
      const { outputs } = await markdown(
        "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>"
      );
      expect(outputs[0].toString()).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |");
    });
  });

  describe("hostile markup", function () {
    const refused = async (args, input, message) => {
      const started = Date.now();
      const { meta, outputs } = await run(args, input);
      expect(meta.error).toBe(message);
      expect(outputs).toEqual([]);
      // refused before it is parsed, or as soon as the parser reaches the limit
      expect(Date.now() - started).toBeLessThan(5000);
    };
    const operations = [
      { op: "scan", kind: "images" },
      {
        op: "rewrite",
        kind: "images",
        replacements: [["https://example.com/a.png", "_a.png"]],
      },
      { op: "markdown" },
    ];

    it("refuses a page over MAX_HTML_BYTES, whatever is in it", async function () {
      for (const filler of ["x", "&amp;", "<!--"]) {
        const huge =
          "<p>" +
          filler.repeat(Math.ceil(html.MAX_HTML_BYTES / filler.length) + 1);
        for (const args of operations)
          await refused(args, huge, "markup is too large");
      }
      await refused(
        operations[0],
        '<img src="data:image/png;base64,' +
          "A".repeat(html.MAX_HTML_BYTES) +
          '">',
        "markup is too large"
      );
    });

    it("refuses a page with more than MAX_TAGS tags", async function () {
      const many = "<a>x</a>".repeat(html.MAX_TAGS / 2 + 1);
      for (const args of operations)
        await refused(args, many, "markup has too many tags");
      const links = Array.from(
        { length: html.MAX_TAGS },
        (_, i) => `<a href="https://example.com/${i}.pdf">l</a>`
      ).join("");
      await refused(
        { op: "scan", kind: "pdfs" },
        links,
        "markup has too many tags"
      );
    });

    it("answers a page with just under MAX_TAGS tags", async function () {
      const links = Array.from(
        { length: html.MAX_TAGS / 2 - 1 },
        (_, i) => `<a href="https://example.com/${i}.pdf">l</a>`
      ).join("");
      const { meta } = await scan("pdfs", links);
      expect(meta.urls.length).toBe(html.MAX_URLS);
      expect((await markdown(links)).meta.error).toBeUndefined();
    });

    it("refuses a tag with too many attributes, which parse5 takes minutes over", async function () {
      const attributes = Array.from(
        { length: 100 * 1000 },
        (_, i) => "a" + i
      ).join(" ");
      for (const args of operations)
        await refused(
          args,
          `<img ${attributes}>`,
          "markup has a tag with too many attributes"
        );
    });

    it("refuses markup nested deeper than the parser can write back", async function () {
      for (const depth of [1000, 10 * 1000, 29 * 1000]) {
        for (const tag of ["div", "span", "blockquote"]) {
          const deep =
            `<${tag}>`.repeat(depth) + '<img src="https://example.com/a.png">';
          for (const args of operations)
            await refused(args, deep, "markup is nested too deeply");
        }
      }
      const tables = "<table><tr><td>".repeat(1000);
      for (const args of operations)
        await refused(args, tables, "markup is nested too deeply");
    });

    it("answers a page nested as deep as a real one can be", async function () {
      const nested =
        "<div>".repeat(100) +
        '<img src="https://example.com/a.png">' +
        "</div>".repeat(100);
      const { meta, outputs } = await scan("images", nested);
      expect(meta.urls).toEqual(["https://example.com/a.png"]);
      expect(outputs[0].toString()).toBe(parseAsBefore(nested).html());
    });

    it("is not fooled by stray closing tags between the opening ones", async function () {
      const deep = "<div></b>".repeat(5000);
      await refused(operations[0], deep, "markup is nested too deeply");
    });

    it("answers markup that is not HTML at all, and an empty page", async function () {
      for (const input of [
        "",
        "\u0000\u0001<\u0002>",
        "<<<<>>>><",
        "<a",
        '<a href="',
        "<!--",
        "<![CDATA[ x ]]>",
        "�".repeat(1000),
      ]) {
        for (const args of operations) {
          const { meta } = await run(args, input);
          expect(meta.error).toBeUndefined();
        }
      }
    });

    it("answers an unknown operation or kind as an error, not a failure", async function () {
      for (const args of [
        undefined,
        null,
        "scan",
        [],
        {},
        { op: "eval" },
        { op: "__proto__" },
        { op: "constructor" },
      ]) {
        const { meta } = await run(args, "<p>x</p>");
        expect(meta.error).toBe("unknown operation");
      }
      for (const kind of [
        undefined,
        "links",
        "__proto__",
        "constructor",
        "toString",
        5,
      ]) {
        const { meta } = await scan(kind, "<p>x</p>");
        expect(meta.error).toBe("unknown kind");
      }
    });

    it("takes no selector, function or option from the caller", async function () {
      const post =
        '<img src="https://example.com/a.png"><div class="x">y</div>';
      const { meta, outputs } = await run(
        {
          op: "scan",
          kind: "images",
          selector: "div",
          tag: "div",
          attribute: "class",
          wanted: "() => true",
          options: { xmlMode: true },
        },
        post
      );
      expect(meta.urls).toEqual(["https://example.com/a.png"]);
      expect(outputs[0].toString()).toBe(parseAsBefore(post).html());
    });
  });

  describe("html.extract", function () {
    const page = (tags) =>
      `<!doctype html><html><head>${tags}</head><body></body></html>`;
    const video = (src, width, height) =>
      page(
        `<meta property="og:video" content="${src}"><meta property="og:video:width" content="${width}">` +
          `<meta property="og:video:height" content="${height}">`
      );

    it("og-video returns the player's address and size", function () {
      expect(
        html.extract(
          "og-video",
          video("https://bandcamp.com/EmbeddedPlayer/v=2/album=1/", 400, 120)
        )
      ).toEqual({
        src: "https://bandcamp.com/EmbeddedPlayer/v=2/album=1/",
        width: 400,
        height: 120,
      });
    });

    it("og-video uses the first of a tag and trims what it returns", function () {
      const tags =
        '<meta property="og:video" content="  https://example.com/a  ">' +
        '<meta property="og:video" content="https://example.com/b">' +
        '<meta property="og:video:width" content=" 300 "><meta property="og:video:height" content="200">';
      expect(html.extract("og-video", page(tags))).toEqual({
        src: "https://example.com/a",
        width: 300,
        height: 200,
      });
    });

    it("og-video leaves out what is missing or not valid", function () {
      expect(html.extract("og-video", page(""))).toEqual({});

      const hostile = [
        "javascript:alert(1)",
        "data:text/html;base64,AAAA",
        "//example.com/player",
        "/player",
        "ftp://example.com/player",
        "https://example.com/a b",
        "https://example.com/a&quot; onload=&quot;x",
        "https://example.com/" + "a".repeat(html.MAX_URL_LENGTH),
        "",
      ];
      for (const src of hostile) {
        expect(html.extract("og-video", video(src, 400, 120))).toEqual({
          width: 400,
          height: 120,
        });
      }
      // a quote that the parser leaves in a value is refused, not escaped
      expect(
        html.extract(
          "og-video",
          page("<meta property=og:video content='https://example.com/a\"b'>")
        ).src
      ).toBeUndefined();
      expect(
        html.extract(
          "og-video",
          page("<meta property=og:video content='https://example.com/a<b>c'>")
        ).src
      ).toBeUndefined();

      for (const size of [
        "",
        "abc",
        "-5",
        "0",
        "1.5",
        "1e3",
        "100000",
        "99999999999",
        "NaN",
        "Infinity",
        "12px",
      ]) {
        expect(
          html.extract("og-video", video("https://example.com/a", size, size))
        ).toEqual({ src: "https://example.com/a" });
      }
    });

    it("only runs a named extraction", function () {
      for (const name of [
        undefined,
        "",
        "meta",
        "__proto__",
        "constructor",
        "toString",
        "$('x')",
      ]) {
        expect(() => html.extract(name, page(""))).toThrowError(
          html.MarkupError
        );
      }
    });

    it("refuses what the parse-html job refuses", function () {
      expect(() =>
        html.extract("og-video", "x".repeat(html.MAX_HTML_BYTES + 1))
      ).toThrowError(html.MarkupError);
      expect(() => html.extract("og-video", "<div>".repeat(5000))).toThrowError(
        html.MarkupError
      );
    });
  });

  describe("the importer's stages", function () {
    const fs = require("fs");
    const path = require("path");
    const helper = path.join(__dirname, "../../dashboard/site/import/helper");

    it("do not parse HTML in Node", function () {
      for (const file of [
        "download_images",
        "download_pdfs",
        "download_audio",
        "convert_to_markdown",
      ]) {
        const source = fs.readFileSync(path.join(helper, file + ".js"), "utf8");
        expect(source).not.toMatch(
          /require\(["'](cheerio|turndown|parse5|domino|jsdom)/
        );
        expect(source).toContain("html_assets");
      }
    });
  });
});
