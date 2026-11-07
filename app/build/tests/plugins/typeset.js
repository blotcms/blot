const build = require("build");
const folder = require("storage/folder");

describe("typeset plugin", function () {
  require("./util/setup")();

  it("treats string false values as disabled for punctuation and small caps", async function () {
    const path = "/typeset-disabled.txt";
    const contents = 'He said "Hello" -- and NASA.';

    this.blog.plugins.typeset = {
      enabled: true,
      options: {
        punctuation: "off",
        smallCaps: "false",
      },
    };

    await folder.write(this.blog.id, path, contents);

    const entry = await build(this.blog, path);

    expect(entry.html).not.toContain('<span class="small-caps">');
    expect(entry.html).not.toContain("—");
    expect(entry.html).not.toContain("&mdash;");
    expect(entry.html).not.toContain("&thinsp;");
    expect(entry.html).not.toContain(" ");
  });

  it("treats string true values as enabled for punctuation and small caps", async function () {
    const path = "/typeset-enabled.txt";
    const contents = 'He said "Hello" -- and NASA.';

    this.blog.plugins.typeset = {
      enabled: "true",
      options: {
        punctuation: "on",
        smallCaps: "1",
      },
    };

    await folder.write(this.blog.id, path, contents);

    const entry = await build(this.blog, path);

    expect(entry.html).toContain('<span class="small-caps">NASA</span>');
    expect(entry.html).toContain("“");
    expect(/&mdash;|—/.test(entry.html)).toEqual(true);
  });

  describe("quotes", function () {
    const plugin = require("build/plugins/typeset");

    function run(html) {
      return new Promise(function (resolve) {
        plugin.prerender(
          html,
          function (err, html) {
            resolve(html);
          },
          { punctuation: true, smallCaps: false, hangingPunctuation: false }
        );
      });
    }

    it("uses the whole paragraph as context across inline tags", async function () {
      expect(
        await run(
          '<p>He said "see <a href="x">this</a> and <em>that</em>" today.</p>'
        )
      ).toEqual(
        '<p>He said “see <a href="x">this</a> and <em>that</em>” today.</p>'
      );
    });

    it("handles apostrophes, years and primes next to inline tags", async function () {
      expect(
        await run("<p>It's the <a href=\"x\">'93</a> class, 5'10\" tall.</p>")
      ).toEqual('<p>It’s the <a href="x">’93</a> class, 5′10″ tall.</p>');
    });

    // A paragraph with no blank lines becomes one huge <p>. Quote
    // substitution used to be quadratic in its size and blocked the event
    // loop for ~9s at 42KB, long enough to lapse the sync folder lock.
    it("typesets one very large paragraph with many inline tags quickly", async function () {
      let inner = "";

      while (inner.length < 40 * 1024)
        inner +=
          'He said "see <a href="http://example.com/' +
          inner.length +
          "\">this link</a> and <em>that</em>\" it's the '93 <span>thing</span> <br>";

      const start = Date.now();
      const result = await run("<p>" + inner + "</p>");
      const elapsed = Date.now() - start;

      expect(result).toContain("He said “see <a");
      expect(result).toContain("</em>” it’s the ’93 ");
      expect(elapsed).toBeLessThan(1000);
    });
  });

  // The plugin runs typeset's modules through its own walk (./walk), which
  // parses the document once rather than once per module.
  describe("walk", function () {
    const typeset = require("typeset");
    const walk = require("build/plugins/typeset/walk");

    const DOCUMENTS = [
      "<p>He said \"Hello\" -- and NASA's 'big' rocket... It's '93, 5'10\" tall.</p>",
      '<p>"<em>quoted</em>" and \'single <a href="x">link</a>\' -- “already” — USA, UK. (FBI)</p><p>A</p>',
      'text outside <p>"inside"</p> more "outside"',
      '<!-- "comment" --><pre>"code" -- NASA</pre><code>\'x\'</code><p>&quot;ent&quot; &#39;s &amp; R&amp;D &lt;tag&gt;</p>',
      '<p><span class="math">"$x$"</span> "a" <span class="small-caps">NASA</span> CIA</p>',
      '<h1>"Title" -- NASA</h1><ul><li>\'one\'</li><li>"two" ... </li></ul><blockquote>"Cat" said Ox.</blockquote>',
      '<p>“Curly” ‘quotes’ Wow. Oh "yes" Yo, Total. VW, AVIS</p><script>var a="b"; // --</script>',
      '<table><tr><td>"cell" -- NB</td></tr></table><div class="pull-x">"no"</div>',
      "",
      "<p></p><p> </p><p>\"</p><p>'</p>",
    ];

    // Every combination of the plugin's options, as prerender passes them
    const COMBINATIONS = [];
    [true, false].forEach((punctuation) =>
      [true, false].forEach((smallCaps) =>
        [true, false].forEach((hangingPunctuation) => {
          const disable = ["ligatures", "hyphenate"];
          if (!punctuation) disable.push("spaces", "quotes", "punctuation");
          if (!smallCaps) disable.push("smallCaps");
          if (!hangingPunctuation) disable.push("hangingPunctuation");
          COMBINATIONS.push({ disable, ignore: ["span.math"] });
        })
      )
    );

    it("gives the same HTML as typeset", function () {
      DOCUMENTS.forEach((html) =>
        COMBINATIONS.forEach((options) =>
          expect(walk(html, options)).toEqual(typeset(html, options))
        )
      );
    });

    // typeset serialized and re-parsed the document between modules, which
    // mangled a single-quoted attribute holding a double quote a little more
    // each time
    it("serializes the document once", function () {
      const html = '<p>"x"</p><img alt=\'"x"\' src="a.jpg">';
      const options = { disable: ["ligatures", "hyphenate"] };

      expect(typeset(html, options)).toContain('<img alt x"" src="a.jpg">');
      expect(walk(html, options)).toContain('<img alt=""x"" src="a.jpg">');
    });
  });
});
