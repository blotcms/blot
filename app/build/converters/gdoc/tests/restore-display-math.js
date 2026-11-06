const cheerio = require("cheerio");
const restoreDisplayMath = require("../restore-display-math");

describe("restore Google Docs display math paragraphs", function () {
  it("isolates a display whose delimiters were joined with line breaks", function () {
    const $ = cheerio.load(
      "<p>Display equation follows:<br>$$<br>" +
        "\\int_0^\\infty e^{-x}\\,dx = 1<br>$$</p>",
      { decodeEntities: false },
      false
    );

    restoreDisplayMath($);

    expect($("p").length).toBe(2);
    expect($("p").first().text()).toBe("Display equation follows:");
    expect($("p").last().text()).toBe(
      "$$\n\\int_0^\\infty e^{-x}\\,dx = 1\n$$"
    );
  });

  it("does not span formatted lines", function () {
    const input = "<p>$$<br>x<br><strong>unrelated</strong><br>$$</p>";
    const $ = cheerio.load(input, { decodeEntities: false }, false);

    restoreDisplayMath($);

    expect($.html()).toBe(input);
  });
});
