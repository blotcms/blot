const cheerio = require("cheerio");
const orgConvert = require("../../../converters/org/convert");
const { render } = require("../index");

describe("org: display math glued to prose by single newlines", function () {
  const blog = { id: "loose-display-math-org-test" };

  async function convertAndRender(text) {
    const [html] = await orgConvert(blog, text);

    const $ = cheerio.load(html, { decodeEntities: false }, false);
    await render($, {});
    return $.html();
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
