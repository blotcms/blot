const { clean, render } = require("../markdown");

describe("img ImageDescription Markdown", function () {
  describe("clean", function () {
    it("returns null for missing and blank descriptions", function () {
      expect(clean(undefined)).toBeNull();
      expect(clean(42)).toBeNull();
      expect(clean("")).toBeNull();
      expect(clean("                               ")).toBeNull();
      expect(clean("\n\t ")).toBeNull();
      expect(clean("\u0000\u0000")).toBeNull();
    });

    it("drops the descriptions cameras write", function () {
      expect(clean("OLYMPUS DIGITAL CAMERA")).toBeNull();
      expect(clean("OLYMPUS DIGITAL CAMERA         ")).toBeNull();
      expect(clean("SONY DSC")).toBeNull();
      expect(clean("  SONY DSC  ")).toBeNull();
      expect(clean("Exif_JPEG_PICTURE")).toBeNull();
      expect(clean("JENOPTIK DIGITAL CAMERA")).toBeNull();
    });

    it("keeps a caption which mentions a camera", function () {
      expect(clean("Shot on a SONY DSC")).toEqual("Shot on a SONY DSC");
    });

    it("trims padding and normalises line endings", function () {
      expect(clean("  A caption\r\nsecond line  ")).toEqual(
        "A caption\nsecond line"
      );
    });
  });

  describe("render", function () {
    it("returns null when there is no caption", function () {
      expect(render(undefined)).toBeNull();
      expect(render("SONY DSC")).toBeNull();
    });

    it("renders bold, italic, code and links", function () {
      expect(
        render(
          "**Bold**, *italic*, _also italic_, `code` and [a link](https://example.com)"
        )
      ).toEqual(
        '<strong>Bold</strong>, <em>italic</em>, <em>also italic</em>, <code>code</code> and <a href="https://example.com">a link</a>'
      );
    });

    it("keeps a link's title", function () {
      expect(render('[Ann](https://ann.example "Ann Lee")')).toEqual(
        '<a href="https://ann.example" title="Ann Lee">Ann</a>'
      );
    });

    it("does not italicise underscores inside filename-like captions", function () {
      expect(render("IMG_2041_final_v2")).toEqual("IMG_2041_final_v2");
      expect(render("snake_case_name.jpg")).toEqual("snake_case_name.jpg");
    });

    it("leaves a lone asterisk as written", function () {
      expect(render("*")).toEqual("*");
      expect(render("Footnote*")).toEqual("Footnote*");
      expect(render("5 * 3 = 15")).toEqual("5 * 3 = 15");
    });

    it("turns line breaks into <br>", function () {
      expect(render("First line\nsecond line")).toEqual(
        "First line<br>second line"
      );
      expect(render("Hard  \nbreak")).toEqual("Hard<br>break");
    });

    it("leaves block syntax as text", function () {
      expect(render("# Not a heading\n- not a list\n> not a quote")).toEqual(
        "# Not a heading<br>- not a list<br>&gt; not a quote"
      );
      expect(render("1. Not a list")).toEqual("1. Not a list");
    });

    it("passes raw HTML through as written", function () {
      expect(render('<b>hi</b> and <span class="x">there</span>')).toEqual(
        '<b>hi</b> and <span class="x">there</span>'
      );
    });

    it("renders images", function () {
      expect(render("![alt](https://example.com/a.png)")).toEqual(
        '<img src="https://example.com/a.png" alt="alt">'
      );
    });

    it("keeps relative and mailto links", function () {
      expect(render("[r](/photos/a.jpg)")).toEqual(
        '<a href="/photos/a.jpg">r</a>'
      );
      expect(render("[m](mailto:ann@example.com)")).toEqual(
        '<a href="mailto:ann@example.com">m</a>'
      );
    });

    it("does not link bare URLs or strike through", function () {
      expect(render("https://example.com ~~no~~")).toEqual(
        "https://example.com ~~no~~"
      );
    });

    it("escapes ampersands and keeps other characters", function () {
      expect(render("Café & “quotes” 日本")).toEqual(
        "Café &amp; “quotes” 日本"
      );
    });
  });
});
