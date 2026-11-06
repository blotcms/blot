const cheerio = require("cheerio");
const { render } = require("../index");

describe("katex pandoc math spans", function () {
  function renderHtml(html, callback) {
    const $ = cheerio.load(html, { decodeEntities: false }, false);
    render($, function (err) {
      if (err) return callback(err);
      callback(null, $.html());
    });
  }

  it("renders span.math.inline without markdown emphasis tags", function (done) {
    const input = '<p>Inline <span class="math inline">a+b</span> math</p>';

    renderHtml(input, function (err, html) {
      if (err) return done.fail(err);
      expect(html).toContain('class="katex"');
      expect(html).not.toContain('class="math');
      expect(html).toContain(">a+b</annotation>");
      done();
    });
  });

  it("renders underscore-heavy display math without em tags", function (done) {
    const tex =
      "\\mathbf{v}_1^{\\text{cm}} = \\mathbf{v} - \\mathbf{v}_{\\text{cm}} = \\frac{\\mathbf{v}}{2}";
    const input = `<p><span class="math display">${tex}</span></p>`;

    renderHtml(input, function (err, html) {
      if (err) return done.fail(err);
      expect(html).toContain('class="katex-display"');
      expect(html).toContain('class="katex"');
      expect(html).not.toContain("<em>");
      expect(html).not.toContain('class="math');
      expect(html).toContain(tex);
      done();
    });
  });

  it("falls back to escaped inline TeX with inline delimiters", function (done) {
    const input =
      '<p>Inline <span class="math inline">\\frac{&lt;img src=x onerror=alert(1)&gt;</span> math</p>';

    renderHtml(input, function (err, html) {
      if (err) return done.fail(err);
      expect(html).toContain("$\\frac{&lt;img src=x onerror=alert(1)&gt;$");
      expect(html).not.toContain("<img");
      expect(html).not.toContain('class="math');
      done();
    });
  });

  it("falls back to escaped display TeX with display delimiters", function (done) {
    const input =
      '<p><span class="math display">\\frac{&lt;script&gt;alert(1)&lt;/script&gt;</span></p>';

    renderHtml(input, function (err, html) {
      if (err) return done.fail(err);
      expect(html).toContain(
        "$$\\frac{&lt;script&gt;alert(1)&lt;/script&gt;$$"
      );
      expect(html).not.toContain("<script>");
      expect(html).not.toContain('class="math');
      done();
    });
  });

  it("leaves user-authored math spans inside skipped tags untouched", function (done) {
    const input =
      '<pre><code><span class="math inline">a+b</span></code></pre>';

    renderHtml(input, function (err, html) {
      if (err) return done.fail(err);
      expect(html).not.toContain('class="katex"');
      expect(html).toContain('<span class="math inline">a+b</span>');
      done();
    });
  });

  it("renders user-authored math spans", function (done) {
    const input = '<p><span class="math inline">not raw TeX</span></p>';

    renderHtml(input, function (err, html) {
      if (err) return done.fail(err);
      expect(html).toContain('class="katex"');
      expect(html).not.toContain('class="math');
      expect(html).toContain(">not raw TeX</annotation>");
      done();
    });
  });

  it("renders display-class math mixed directly with list-item text inline", function (done) {
    const input = '<ul><li>Value <span class="math display">x</span></li></ul>';

    renderHtml(input, function (err, html) {
      if (err) return done.fail(err);
      expect(html).toContain('class="katex"');
      expect(html).not.toContain('class="katex-display"');
      done();
    });
  });

  ["em", "strong"].forEach(function (tag) {
    it(
      "renders mixed list-item math nested inside " + tag + " inline",
      function (done) {
        const input = `<ul><li><${tag}>Value <span class="math display">x</span></${tag}></li></ul>`;

        renderHtml(input, function (err, html) {
          if (err) return done.fail(err);
          expect(html).not.toContain('class="katex-display"');
          done();
        });
      }
    );
  });

  it("keeps math that is the sole meaningful list-item child displayed", function (done) {
    const input = '<ul><li><span class="math display">x</span></li></ul>';

    renderHtml(input, function (err, html) {
      if (err) return done.fail(err);
      expect(html).toContain('class="katex-display"');
      done();
    });
  });

  ["p", "li"].forEach(function (boundary) {
    it(
      "keeps math in an empty inline wrapper displayed in " + boundary,
      function (done) {
        const input = `<${boundary}><em><span class="math display">x</span></em></${boundary}>`;

        renderHtml(input, function (err, html) {
          if (err) return done.fail(err);
          expect(html).toContain('class="katex-display"');
          done();
        });
      }
    );
  });

  it("renders mixed display-class math in headings and table cells inline", function (done) {
    const input =
      '<h2>Heading <span class="math display">x</span></h2><table><tr><td><span class="math display">y</span> cell</td></tr></table>';

    renderHtml(input, function (err, html) {
      if (err) return done.fail(err);
      expect((html.match(/class="katex"/g) || []).length).toBe(2);
      expect(html).not.toContain('class="katex-display"');
      done();
    });
  });

  it("ignores whitespace-only siblings when choosing display mode", function (done) {
    const input =
      '<p> \n <strong>\t<span class="math display">x</span> </strong> \n </p>';

    renderHtml(input, function (err, html) {
      if (err) return done.fail(err);
      expect(html).toContain('class="katex-display"');
      done();
    });
  });

  it("does not use structure outside the nearest boundary in nested lists", function (done) {
    const input =
      '<ul><li>Outer text<ul><li> \n <em><span class="math display">x</span></em> \n </li></ul></li></ul>';

    renderHtml(input, function (err, html) {
      if (err) return done.fail(err);
      expect(html).toContain('class="katex-display"');
      done();
    });
  });
});
