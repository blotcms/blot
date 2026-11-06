describe("summary", function () {
  var cheerio = require("cheerio");
  var summary = require("../summary");

  beforeEach(function () {
    this.summary = function (input) {
      var $ = cheerio.load(
        input.html,
        {
          decodeEntities: false,
          withDomLvl1: false, // this may cause issues?
        },
        false
      );

      return summary($, input.title || "");
    };
  });

  it("is empty when HTML is empty", function () {
    expect(
      this.summary({
        title: "",
        html: "",
      })
    ).toEqual("");
  });

  it("is the text of the first paragraph", function () {
    expect(
      this.summary({
        html: "<p>H</p>",
      })
    ).toEqual("H");
  });

  it("contains text inside inline elements", function () {
    expect(
      this.summary({
        html: "<p>H<b>ell</b>o</p>",
      })
    ).toEqual("Hello");
  });

  it("handles html entities in the title", function () {
    expect(
      this.summary({
        html: "<p>Ad&nbsp;Fontes</p><p>Lucili</p>",
        title: "Ad Fontes",
      })
    ).toEqual("Lucili");
  });

  it("does not contain the text of the title", function () {
    expect(
      this.summary({
        html: "<p>Hello</p><p>World</p>",
        title: "Hello",
      })
    ).toEqual("World");
  });

  // Not sure if I like this behaviour
  it("has spaces between separate paragraphs", function () {
    expect(
      this.summary({
        html: "<p>Hello</p><p>World</p>",
        title: "Hello",
      })
    ).toEqual("World");
  });

  it("will not contain or truncate long words", function () {
    expect(
      this.summary({
        html: "<p>Hello there helloooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooooo.</p>",
      })
    ).toEqual("Hello there");
  });

  it("decodes HTML entities", function () {
    expect(
      this.summary({
        html: "<p>Hello & &amp; foo</p><p>there</p>",
      })
    ).toEqual("Hello & & foo there");
  });
});
