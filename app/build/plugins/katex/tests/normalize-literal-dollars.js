const cheerio = require("cheerio");
const {
  normalizeLiteralDollarMath,
  normalizeMathInText,
  tokenizeDollarMath,
} = require("../../../math/normalizeLiteralDollars");
const { render } = require("../index");

describe("literal dollar math normalization", function () {
  function normalizeAndRender(html, callback) {
    const $ = cheerio.load(html, { decodeEntities: false }, false);
    normalizeLiteralDollarMath($);
    render($, function (err) {
      if (err) return callback(err);
      callback(null, $.html());
    });
  }

  it("normalizes literal $$ before KaTeX rendering", function (done) {
    normalizeAndRender("<p>Inline $$a+b$$ math</p>", function (err, html) {
      if (err) return done.fail(err);
      expect(html).toContain('class="katex"');
      expect(html).not.toContain("$$a+b$$");
      done();
    });
  });

  it("normalizes math in original siblings after an expanding replacement", function (done) {
    const input = "<p>First $x$ then <em>$y$</em><strong>after</strong></p>";

    normalizeAndRender(input, function (err, html) {
      if (err) return done.fail(err);
      const $ = cheerio.load(html, { decodeEntities: false }, false);
      expect($(".katex").length).toBe(2);
      expect(html).not.toContain("$x$");
      expect(html).not.toContain("$y$");
      expect($("strong").text()).toBe("after");
      done();
    });
  });

  it("leaves literal $$ untouched during the KaTeX render phase", function (done) {
    const $ = cheerio.load(
      "<p>Inline $$a+b$$ math</p>",
      { decodeEntities: false },
      false
    );

    render($, function (err) {
      if (err) return done.fail(err);
      const html = $.html();
      expect(html).not.toContain('class="katex"');
      expect(html).toContain("$$a+b$$");
      done();
    });
  });

  it("normalizes single-dollar inline math", function () {
    expect(normalizeMathInText("Inline $x$ math")).toBe(
      'Inline <span class="math inline">x</span> math'
    );
  });

  it("normalizes double-dollar math with existing inline/display semantics", function () {
    expect(normalizeMathInText("Inline $$x$$ math")).toBe(
      'Inline <span class="math inline">x</span> math'
    );
    expect(normalizeMathInText("$$x$$")).toBe(
      '<span class="math display">x</span>'
    );
  });

  it("normalizes adjacent single- and double-dollar math", function () {
    expect(normalizeMathInText("$x$ and $$y$$")).toBe(
      '<span class="math inline">x</span> and <span class="math inline">y</span>'
    );
  });

  it("leaves empty dollar-delimited runs literal", function () {
    ["$$$$", "$$ $$", "Text $$$$ text", "$$$ a+b $$$"].forEach((input) => {
      expect(normalizeMathInText(input)).toBe(input);
      expect(tokenizeDollarMath(input)).toEqual([
        { type: "text", value: input },
      ]);
    });
  });

  it("preserves empty dollar-delimited runs through KaTeX rendering", function (done) {
    const inputs = ["$$$$", "$$ $$", "Text $$$$ text", "$$$ a+b $$$"];
    const input = inputs.map((value) => "<p>" + value + "</p>").join("");

    normalizeAndRender(input, function (err, html) {
      if (err) return done.fail(err);
      inputs.forEach((value) => {
        expect(html).toContain("<p>" + value + "</p>");
      });
      expect(html).not.toContain('class="katex"');
      expect(html).not.toContain('class="math');
      done();
    });
  });

  it("leaves currency text literal", function () {
    expect(normalizeMathInText("Prices are $5 and $10 today")).toBe(
      "Prices are $5 and $10 today"
    );
  });

  it("leaves escaped dollars literal", function () {
    expect(normalizeMathInText("Escaped \\$x\\$ math")).toBe(
      "Escaped \\$x\\$ math"
    );
  });

  it("tokenizes escaped dollars as text", function () {
    expect(tokenizeDollarMath("Escaped \\$x\\$ math")).toEqual([
      { type: "text", value: "Escaped \\$x\\$ math" },
    ]);
  });

  it("tokenizes unmatched dollars as text", function () {
    expect(tokenizeDollarMath("Unmatched $x math")).toEqual([
      { type: "text", value: "Unmatched $x math" },
    ]);
  });

  it("tokenizes currency as text", function () {
    expect(tokenizeDollarMath("Prices are $5 and $10 today")).toEqual([
      { type: "text", value: "Prices are $5 and $10 today" },
    ]);
  });

  it("does not split an overlong run into adjacent delimiters", function () {
    expect(tokenizeDollarMath("$x$$$y$$")).toEqual([
      { type: "text", value: "$x$$$y$$" },
    ]);
    expect(normalizeMathInText("$$a+b$$$$c+d$$")).toBe("$$a+b$$$$c+d$$");
  });

  it("does not pair inline delimiters across lines", function () {
    expect(normalizeMathInText("First $x\nsecond line $10")).toBe(
      "First $x\nsecond line $10"
    );
  });

  it("only pairs multiline display delimiters on their own lines", function () {
    expect(normalizeMathInText("First $$x\nsecond line $$y")).toBe(
      "First $$x\nsecond line $$y"
    );
    expect(normalizeMathInText("$$\nx+y\n$$")).toBe(
      '<span class="math display">x+y</span>'
    );
  });

  it("keeps the line break after inline double-dollar math", function (done) {
    normalizeAndRender("<p>$$x$$<br>next</p>", function (err, html) {
      if (err) return done.fail(err);
      const $ = cheerio.load(html, { decodeEntities: false }, false);
      expect($(".katex").length).toBe(1);
      expect($(".katex-display").length).toBe(0);
      expect($("br").length).toBe(1);
      expect($("p").text()).toContain("next");
      done();
    });
  });

  it("does not consume line breaks for an unfinished delimiter", function (done) {
    normalizeAndRender("<p>Unfinished $$x<br>next</p>", function (err, html) {
      if (err) return done.fail(err);
      const $ = cheerio.load(html, { decodeEntities: false }, false);
      expect($(".katex").length).toBe(0);
      expect($("br").length).toBe(1);
      expect($("p").html()).toBe("Unfinished $$x<br>next");
      done();
    });
  });

  it("normalizes a bounded three-line display and preserves surrounding content", function (done) {
    const input = "<p>before<br>$$<br>x+y<br>$$<br>after</p>";
    normalizeAndRender(input, function (err, html) {
      if (err) return done.fail(err);
      const $ = cheerio.load(html, { decodeEntities: false }, false);
      // Display tokens mixed with other paragraph content render inline.
      expect($(".katex").length).toBe(1);
      expect($(".katex-display").length).toBe(0);
      expect($("br").length).toBe(4);
      expect($("p").text()).toContain("before");
      expect($("p").text()).toContain("after");
      done();
    });
  });

  it("preserves unrelated line breaks around display math", function (done) {
    const input = "<p>one<br>two<br>$$<br>z<br>$$<br>three<br>four</p>";
    normalizeAndRender(input, function (err, html) {
      if (err) return done.fail(err);
      const $ = cheerio.load(html, { decodeEntities: false }, false);
      expect($(".katex").length).toBe(1);
      expect($(".katex-display").length).toBe(0);
      expect($("br").length).toBe(6);
      expect($("p").text()).toContain("onetwo");
      expect($("p").text()).toContain("threefour");
      done();
    });
  });
});
