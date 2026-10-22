const build = require("build");
const fs = require("fs-extra");

describe("typeset plugin", function () {
  require("./util/setup")();

  it("treats string false values as disabled for punctuation and small caps", function (done) {
    const path = "/typeset-disabled.txt";
    const contents = 'He said "Hello" -- and NASA.';

    this.blog.plugins.typeset = {
      enabled: true,
      options: {
        punctuation: "off",
        smallCaps: "false",
      },
    };

    fs.outputFileSync(this.blogDirectory + path, contents);

    build(this.blog, path, function (err, entry) {
      expect(err).toBeNull();
      expect(entry.html).not.toContain('<span class="small-caps">');
      expect(entry.html).not.toContain("—");
      expect(entry.html).not.toContain("&mdash;");
      expect(entry.html).not.toContain("&thinsp;");
      expect(entry.html).not.toContain(" ");
      done();
    });
  });

  it("treats string true values as enabled for punctuation and small caps", function (done) {
    const path = "/typeset-enabled.txt";
    const contents = 'He said "Hello" -- and NASA.';

    this.blog.plugins.typeset = {
      enabled: "true",
      options: {
        punctuation: "on",
        smallCaps: "1",
      },
    };

    fs.outputFileSync(this.blogDirectory + path, contents);

    build(this.blog, path, function (err, entry) {
      expect(err).toBeNull();
      expect(entry.html).toContain('<span class="small-caps">NASA</span>');
      expect(entry.html).toContain("“");
      expect(/&mdash;|—/.test(entry.html)).toEqual(true);
      done();
    });
  });

  describe("quotes", function () {
    const plugin = require("build/plugins/typeset");

    function run(html) {
      let result;
      plugin.prerender(
        html,
        function (err, html) {
          result = html;
        },
        { punctuation: true, smallCaps: false, hangingPunctuation: false }
      );
      return result;
    }

    it("uses the whole paragraph as context across inline tags", function () {
      expect(run('<p>He said "see <a href="x">this</a> and <em>that</em>" today.</p>')).toEqual(
        '<p>He said “see <a href="x">this</a> and <em>that</em>” today.</p>'
      );
    });

    it("handles apostrophes, years and primes next to inline tags", function () {
      expect(run("<p>It's the <a href=\"x\">'93</a> class, 5'10\" tall.</p>")).toEqual(
        '<p>It’s the <a href="x">’93</a> class, 5′10″ tall.</p>'
      );
    });

    // A paragraph with no blank lines becomes one huge <p>. Quote
    // substitution used to be quadratic in its size and blocked the event
    // loop for ~9s at 42KB, long enough to lapse the sync folder lock.
    it("typesets one very large paragraph with many inline tags quickly", function () {
      let inner = "";

      while (inner.length < 40 * 1024)
        inner +=
          'He said "see <a href="http://example.com/' +
          inner.length +
          '">this link</a> and <em>that</em>" it\'s the \'93 <span>thing</span> <br>';

      const start = Date.now();
      const result = run("<p>" + inner + "</p>");
      const elapsed = Date.now() - start;

      expect(result).toContain("He said “see <a");
      expect(result).toContain("</em>” it’s the ’93 ");
      expect(elapsed).toBeLessThan(1000);
    });
  });
});
