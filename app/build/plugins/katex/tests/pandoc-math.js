const cheerio = require("cheerio");
const { render } = require("../index");

describe("katex pandoc math spans", function () {
  async function renderHtml(html) {
    const $ = cheerio.load(html, { decodeEntities: false }, false);
    await render($, {});
    return $.html();
  }

  it("renders span.math.inline without markdown emphasis tags", async function () {
    const input = '<p>Inline <span class="math inline">a+b</span> math</p>';

    const html = await renderHtml(input);
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('class="math');
    expect(html).toContain(">a+b</annotation>");
  });

  it("renders underscore-heavy display math without em tags", async function () {
    const tex =
      "\\mathbf{v}_1^{\\text{cm}} = \\mathbf{v} - \\mathbf{v}_{\\text{cm}} = \\frac{\\mathbf{v}}{2}";
    const input = `<p><span class="math display">${tex}</span></p>`;

    const html = await renderHtml(input);
    expect(html).toContain('class="katex-display"');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("<em>");
    expect(html).not.toContain('class="math');
    expect(html).toContain(tex);
  });

  it("falls back to escaped inline TeX with inline delimiters", async function () {
    const input =
      '<p>Inline <span class="math inline">\\frac{&lt;img src=x onerror=alert(1)&gt;</span> math</p>';

    const html = await renderHtml(input);
    expect(html).toContain("$\\frac{&lt;img src=x onerror=alert(1)&gt;$");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('class="math');
  });

  it("falls back to escaped display TeX with display delimiters", async function () {
    const input =
      '<p><span class="math display">\\frac{&lt;script&gt;alert(1)&lt;/script&gt;</span></p>';

    const html = await renderHtml(input);
    expect(html).toContain("$$\\frac{&lt;script&gt;alert(1)&lt;/script&gt;$$");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('class="math');
  });

  it("leaves user-authored math spans inside skipped tags untouched", async function () {
    const input =
      '<pre><code><span class="math inline">a+b</span></code></pre>';

    const html = await renderHtml(input);
    expect(html).not.toContain('class="katex"');
    expect(html).toContain('<span class="math inline">a+b</span>');
  });

  it("renders user-authored math spans", async function () {
    const input = '<p><span class="math inline">not raw TeX</span></p>';

    const html = await renderHtml(input);
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('class="math');
    expect(html).toContain(">not raw TeX</annotation>");
  });

  it("renders display-class math mixed directly with list-item text inline", async function () {
    const input = '<ul><li>Value <span class="math display">x</span></li></ul>';

    const html = await renderHtml(input);
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('class="katex-display"');
  });

  ["em", "strong"].forEach(function (tag) {
    it(
      "renders mixed list-item math nested inside " + tag + " inline",
      async function () {
        const input = `<ul><li><${tag}>Value <span class="math display">x</span></${tag}></li></ul>`;

        const html = await renderHtml(input);
        expect(html).not.toContain('class="katex-display"');
      }
    );
  });

  it("keeps math that is the sole meaningful list-item child displayed", async function () {
    const input = '<ul><li><span class="math display">x</span></li></ul>';

    const html = await renderHtml(input);
    expect(html).toContain('class="katex-display"');
  });

  ["p", "li"].forEach(function (boundary) {
    it(
      "keeps math in an empty inline wrapper displayed in " + boundary,
      async function () {
        const input = `<${boundary}><em><span class="math display">x</span></em></${boundary}>`;

        const html = await renderHtml(input);
        expect(html).toContain('class="katex-display"');
      }
    );
  });

  it("renders mixed display-class math in headings and table cells inline", async function () {
    const input =
      '<h2>Heading <span class="math display">x</span></h2><table><tr><td><span class="math display">y</span> cell</td></tr></table>';

    const html = await renderHtml(input);
    expect((html.match(/class="katex"/g) || []).length).toBe(2);
    expect(html).not.toContain('class="katex-display"');
  });

  it("ignores whitespace-only siblings when choosing display mode", async function () {
    const input =
      '<p> \n <strong>\t<span class="math display">x</span> </strong> \n </p>';

    const html = await renderHtml(input);
    expect(html).toContain('class="katex-display"');
  });

  it("does not use structure outside the nearest boundary in nested lists", async function () {
    const input =
      '<ul><li>Outer text<ul><li> \n <em><span class="math display">x</span></em> \n </li></ul></li></ul>';

    const html = await renderHtml(input);
    expect(html).toContain('class="katex-display"');
  });
});
