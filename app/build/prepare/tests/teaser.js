var makeTeaser = require("../teaser");

describe("teaser parser", function () {
  function test(html, expected, expectedNewHTML, expectedMore) {
    var teaser = makeTeaser(html) || html;

    it("generates a correct teaser for " + html, function () {
      expect(teaser).toEqual(expected);
      if (expectedMore) expect(expectedMore).toEqual(teaser !== html);
    });
  }

  test(
    "<p>A</p><p>B</p><p>&lt;!- more -&gt;</p>",
    "<p>A</p><p>B</p>",
    "<p>A</p><p>B</p>",
    false
  );

  test(
    "<p>A</p><p>&lt;!&#x2014; more &#x2014;&gt;</p><p>C</p>",
    "<p>A</p>",
    "<p>A</p><p>C</p>",
    true
  );

  test(
    "<p>A<!-- more -->BCD<i>a</i></p><p>D</p>",
    "<p>A</p>",
    "<p>ABCD<i>a</i></p><p>D</p>",
    true
  );

  test(
    "<p>A</p><p>B</p><p>Goodbye &lt;!- more -&gt; Hello</p>",
    "<p>A</p><p>B</p><p>Goodbye </p>",
    "<p>A</p><p>B</p><p>Goodbye  Hello</p>",
    true
  );

  test(
    "<p>A</p><p>B</p><p>C</p><!-- more --><p>D</p>",
    "<p>A</p><p>B</p><p>C</p>",
    "<p>A</p><p>B</p><p>C</p><p>D</p>",
    true
  );

  test("<p>A<!-- more -->BCD</p>", "<p>A</p>", "<p>ABCD</p>", true);

  test(
    "<p>A<!-- more -->BCD</p><p>D</p>",
    "<p>A</p>",
    "<p>ABCD</p><p>D</p>",
    true
  );

  test(
    "Hello {{more}} there {{more}} is...",
    "Hello ",
    "Hello  there {{more}} is...",
    true
  );

  test(
    "Hello {{more}} there is more to come...",
    "Hello ",
    "Hello  there is more to come...",
    true
  );

  test(
    "<script>var a;</script><h1>A</h1><p>B</p><p>C</p><p>D</p><p>E</p><p>F</p><p>G</p>",
    "<script>var a;</script><h1>A</h1><p>B</p><p>C</p><p>D</p><p>E</p>",
    "<script>var a;</script><h1>A</h1><p>B</p><p>C</p><p>D</p><p>E</p><p>F</p><p>G</p>",
    true
  );

  test(
    "<h1>A</h1><p>B</p><p>C</p>",
    "<h1>A</h1><p>B</p><p>C</p>",
    "<h1>A</h1><p>B</p><p>C</p>",
    false
  );

  describe("stripBreakPoint", function () {
    function strip(html, expected) {
      it("removes the marker from " + html, function () {
        expect(makeTeaser.stripBreakPoint(html)).toEqual(expected);
      });
    }

    strip("<p>A</p><p>{{more}}</p><p>B</p>", "<p>A</p><p>B</p>");
    strip("<p>A<!-- more -->BCD</p>", "<p>ABCD</p>");
    strip("<p>A</p><p>&lt;&lt; more &gt;&gt;</p><p>B</p>", "<p>A</p><p>B</p>");
    strip("Hello {{more}} there {{more}} is...", "Hello  there {{more}} is...");
    strip("<p>{{more}} <em>After</em></p>", "<p> <em>After</em></p>");
    strip("<p><!-- more --><em>After</em></p>", "<p><em>After</em></p>");
    strip("  Before {{more}} After", "  Before  After");
    strip("Before {{more}} middle &lt;&lt; more &gt;&gt; after", "Before  middle &lt;&lt; more &gt;&gt; after");
    strip("<p>Explain <code>{{more}}</code> syntax</p>", "<p>Explain <code>{{more}}</code> syntax</p>");
    strip("İ Before {{more}} After", "İ Before  After");
    strip("<p>No marker</p>", "<p>No marker</p>");
    strip("<pre>{{more}}</pre><p>A</p>", "<pre>{{more}}</pre><p>A</p>");
  });
});
