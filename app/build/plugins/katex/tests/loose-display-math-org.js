const cheerio = require("cheerio");
const orgConvert = require("../../../converters/org/convert");
const { render } = require("../index");

describe("org: display math glued to prose by single newlines", function () {
  const blog = { id: "loose-display-math-org-test" };

  function convertAndRender(text) {
    return new Promise((resolve, reject) => {
      orgConvert(blog, text, (err, html) => {
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

  it("keeps math that shares its line with other prose inline", async function () {
    const html = await convertAndRender(
      "the hamilton equations: $$x = y$$ which determine the time evolution."
    );

    expect(html).toContain('class="katex"');
    expect(html).not.toContain('class="katex-display"');
  });
});
