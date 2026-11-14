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

    it("keeps the descriptions cameras write", function () {
      expect(clean("  SONY DSC  ")).toEqual("SONY DSC");
      expect(render("OLYMPUS DIGITAL CAMERA")).toEqual(
        "OLYMPUS DIGITAL CAMERA"
      );
      expect(render("Exif_JPEG_PICTURE")).toEqual("Exif_JPEG_PICTURE");
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
      expect(render("   ")).toBeNull();
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

    it("leaves raw HTML which spans lines as written", function () {
      expect(render('<a\nhref="/about">About</a>\nnext')).toEqual(
        '<a\nhref="/about">About</a><br>next'
      );
    });

    it("turns wikilinks into the markup the wikilinks plugin resolves", function () {
      expect(render("See [[Target]] and [[Target|the target]]")).toEqual(
        'See <a href="Target" title="wikilink">Target</a> and <a href="Target" title="wikilink">the target</a>'
      );
      expect(render("**[[Target]]**")).toEqual(
        '<strong><a href="Target" title="wikilink">Target</a></strong>'
      );
      expect(render("[[ /Sub/Target.txt | text ]]")).toEqual(
        '<a href="/Sub/Target.txt" title="wikilink">text</a>'
      );
    });

    it("turns embedded wikilinks into images", function () {
      expect(render("![[photo.jpg|A photo]]")).toEqual(
        '<img src="photo.jpg" title="wikilink" alt="A photo">'
      );
    });

    it("escapes a wikilink's target and text", function () {
      expect(render('[[Ann & "co" <x>]]')).toEqual(
        '<a href="Ann &amp; &quot;co&quot; &lt;x&gt;" title="wikilink">Ann &amp; &quot;co&quot; &lt;x&gt;</a>'
      );
    });

    it("leaves incomplete wikilinks as written", function () {
      expect(render("[[]]")).toEqual("[[]]");
      expect(render("[[open")).toEqual("[[open");
      expect(render("[[across\nlines]]")).toEqual("[[across<br>lines]]");
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
