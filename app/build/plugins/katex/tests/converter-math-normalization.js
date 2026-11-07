const folder = require("storage/folder");

const markdownConvert = require("../../../converters/markdown/convert");
const orgConvert = require("../../../converters/org/convert");
const rtfConvert = require("../../../converters/rtf/convert");
const htmlConverter = require("../../../converters/html");
const gdocConverter = require("../../../converters/gdoc");
const markdownWithoutPandoc = require("../../../converters/markdown-without-pandoc");
const cheerio = require("cheerio");
const { render } = require("../index");

describe("converter math normalization", function () {
  const blog = {
    id: "math-normalization-test",
    plugins: {
      linebreaks: { enabled: false },
      katex: { enabled: true, options: {} },
    },
  };
  beforeEach(async function () {
    await folder.removeAll(blog.id);
  });

  async function readWith(converter, filePath) {
    const [html] = await converter.read(blog, filePath);
    return html;
  }

  function convertMarkdown(text) {
    return markdownConvert(blog, text, {});
  }

  function convertRtf(text) {
    return rtfConvert(blog, text);
  }

  async function convertDirect(converter, text) {
    const [html] = await converter(blog, text);
    return html;
  }

  async function renderWithKatex(html) {
    const $ = cheerio.load(html, { decodeEntities: false }, false);
    await render($, {});
    return $.html();
  }

  const tex = "\\frac{1}{2}";

  const fixtures = [
    {
      name: "pandoc markdown",
      inline: "Inline $\\frac{1}{2}$ math",
      display: "$$\\frac{1}{2}$$",
      convert(content) {
        return convertMarkdown(content);
      },
    },
    {
      name: "pandoc org",
      inline: "Inline \\(\\frac{1}{2}\\) math",
      display: "\\[\\frac{1}{2}\\]",
      convert(content) {
        return convertDirect(orgConvert, content);
      },
    },
    {
      name: "pandoc rtf",
      inline: "{\\rtf1\\ansi Inline $\\\\frac\\{1\\}\\{2\\}$ math}",
      display: "{\\rtf1\\ansi $$\\\\frac\\{1\\}\\{2\\}$$}",
      convert(content) {
        return convertRtf(content);
      },
    },
    {
      name: "html",
      path: "/math-normalization.html",
      inline: "<p>Inline $\\frac{1}{2}$ math</p>",
      display: "<p>$$\\frac{1}{2}$$</p>",
      convert() {
        return readWith(htmlConverter, this.path);
      },
    },
    {
      name: "gdoc",
      path: "/math-normalization.gdoc",
      inline: "<html><body><p>Inline $\\frac{1}{2}$ math</p></body></html>",
      display: "<html><body><p>$$<br>\\frac{1}{2}<br>$$</p></body></html>",
      convert() {
        return readWith(gdocConverter, this.path);
      },
    },
    {
      name: "markdown without pandoc",
      path: "/math-normalization.md",
      inline: "Inline $\\frac{1}{2}$ math",
      display: "$$\\frac{1}{2}$$",
      convert() {
        return readWith(markdownWithoutPandoc, this.path);
      },
    },
  ];

  const cases = [
    { mode: "inline", className: "inline" },
    { mode: "display", className: "display" },
  ];

  fixtures.forEach((fixture) => {
    cases.forEach(({ mode, className }) => {
      it(
        fixture.name +
          " emits normalized " +
          mode +
          " span.math HTML before KaTeX",
        async function () {
          const content = fixture[mode];

          if (fixture.path) {
            await folder.write(blog.id, fixture.path, content);
          }

          const html = await fixture.convert.call(fixture, content);

          const $ = cheerio.load(html, { decodeEntities: false }, false);
          const $math = $("span.math." + className);

          expect($math.length).toBe(1);
          expect($math.text()).toBe(tex);
          expect(html).not.toContain('class="katex"');

          const rendered = await renderWithKatex(html);
          const renderedDocument = cheerio.load(
            rendered,
            { decodeEntities: false },
            false
          );
          expect(
            renderedDocument("annotation[encoding='application/x-tex']").text()
          ).toBe(tex);
        }
      );
    });
  });
});
