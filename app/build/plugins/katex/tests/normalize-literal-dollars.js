const cheerio = require("cheerio");
const {
  normalizeLiteralDollarMath,
  normalizeMathInText,
  tokenizeDollarMath,
} = require("../../../math/normalizeLiteralDollars");
const { render } = require("../index");

describe("literal dollar math normalization", function () {
  async function normalizeAndRender(html) {
    const $ = cheerio.load(html, { decodeEntities: false }, false);
    normalizeLiteralDollarMath($);
    await render($, {});
    return $.html();
  }

  it("normalizes literal $$ before KaTeX rendering", async function () {
    const html = await normalizeAndRender("<p>Inline $$a+b$$ math</p>");
    expect(html).toContain('class="katex"');
    expect(html).not.toContain("$$a+b$$");
  });

  it("normalizes math in original siblings after an expanding replacement", async function () {
    const input = "<p>First $x$ then <em>$y$</em><strong>after</strong></p>";

    const html = await normalizeAndRender(input);
    const $ = cheerio.load(html, { decodeEntities: false }, false);
    expect($(".katex").length).toBe(2);
    expect(html).not.toContain("$x$");
    expect(html).not.toContain("$y$");
    expect($("strong").text()).toBe("after");
  });

  it("leaves literal $$ untouched during the KaTeX render phase", async function () {
    const $ = cheerio.load(
      "<p>Inline $$a+b$$ math</p>",
      { decodeEntities: false },
      false
    );

    await render($, {});
    const html = $.html();
    expect(html).not.toContain('class="katex"');
    expect(html).toContain("$$a+b$$");
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

  it("preserves empty dollar-delimited runs through KaTeX rendering", async function () {
    const inputs = ["$$$$", "$$ $$", "Text $$$$ text", "$$$ a+b $$$"];
    const input = inputs.map((value) => "<p>" + value + "</p>").join("");

    const html = await normalizeAndRender(input);
    inputs.forEach((value) => {
      expect(html).toContain("<p>" + value + "</p>");
    });
    expect(html).not.toContain('class="katex"');
    expect(html).not.toContain('class="math');
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

  it("keeps the line break after inline double-dollar math", async function () {
    const html = await normalizeAndRender("<p>$$x$$<br>next</p>");
    const $ = cheerio.load(html, { decodeEntities: false }, false);
    expect($(".katex").length).toBe(1);
    expect($(".katex-display").length).toBe(0);
    expect($("br").length).toBe(1);
    expect($("p").text()).toContain("next");
  });

  it("does not consume line breaks for an unfinished delimiter", async function () {
    const html = await normalizeAndRender("<p>Unfinished $$x<br>next</p>");
    const $ = cheerio.load(html, { decodeEntities: false }, false);
    expect($(".katex").length).toBe(0);
    expect($("br").length).toBe(1);
    expect($("p").html()).toBe("Unfinished $$x<br>next");
  });

  it("normalizes a bounded three-line display and preserves surrounding content", async function () {
    const input = "<p>before<br>$$<br>x+y<br>$$<br>after</p>";
    const html = await normalizeAndRender(input);
    const $ = cheerio.load(html, { decodeEntities: false }, false);
    // Display tokens mixed with other paragraph content render inline.
    expect($(".katex").length).toBe(1);
    expect($(".katex-display").length).toBe(0);
    expect($("br").length).toBe(4);
    expect($("p").text()).toContain("before");
    expect($("p").text()).toContain("after");
  });

  it("preserves unrelated line breaks around display math", async function () {
    const input = "<p>one<br>two<br>$$<br>z<br>$$<br>three<br>four</p>";
    const html = await normalizeAndRender(input);
    const $ = cheerio.load(html, { decodeEntities: false }, false);
    expect($(".katex").length).toBe(1);
    expect($(".katex-display").length).toBe(0);
    expect($("br").length).toBe(6);
    expect($("p").text()).toContain("onetwo");
    expect($("p").text()).toContain("threefour");
  });
});
