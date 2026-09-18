const cheerio = require("cheerio");
const markdownConvert = require("../../../converters/markdown/convert");
const { render } = require("../index");

describe("display math glued to prose by single newlines", function () {
  const blog = {
    id: "loose-display-math-test",
    plugins: {
      katex: { enabled: true, options: {} },
    },
  };

  function convertAndRender(text) {
    return new Promise((resolve, reject) => {
      markdownConvert(blog, text, {}, (err, html) => {
        if (err) return reject(err);

        const $ = cheerio.load(html, { decodeEntities: false }, false);
        render($, (renderErr) => {
          if (renderErr) return reject(renderErr);
          resolve($.html());
        });
      });
    });
  }

  it("renders a multi-line $$ block on its own single-newline-separated line as display", async function () {
    const html = await convertAndRender(
      "the hamilton equations:\n$$\nx = y\n$$\nwhich determine the time evolution."
    );

    expect(html).toContain('class="katex-display"');
  });

  it("renders a single-line $$...$$ on its own single-newline-separated line as display", async function () {
    const html = await convertAndRender(
      "the hamilton equations:\n$$x = y$$\nwhich determine the time evolution."
    );

    expect(html).toContain('class="katex-display"');
  });

  it("keeps math that shares its line with other prose inline", async function () {
    const html = await convertAndRender(
      "the hamilton equations: $$x = y$$ which determine the time evolution."
    );

    expect(html).toContain('class="katex"');
    expect(html).not.toContain('class="katex-display"');
  });

  it("keeps a blank-line-separated $$ block on its own line as display", async function () {
    const html = await convertAndRender(
      "the hamilton equations:\n\n$$\nx = y\n$$\n\nwhich determine the time evolution."
    );

    expect(html).toContain('class="katex-display"');
  });
});
