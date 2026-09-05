describe("makeSlug", function () {
  const makeSlug = require("helper/makeSlug");
  const is = require("./util/is")(makeSlug);

  it("works", function () {
    is("!@#$^*()=+[]{}\\|;:'\",?><", "");
    is("foo!@#$^*()=+[]{}\\|;:'\",?><bar", "foo-bar");

    is("", "");
    is("/", "/");
    is("/a/", "a");
    is("/a", "a");
    is("a/", "a");
    is("H", "h");
    is(
      "HelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHelloHello",
      "hellohellohellohellohellohellohellohellohellohellohellohellohellohellohellohellohellohellohellohellohellohello"
    );
    is("100% luck 15% skill", "100-percent-luck-15-percent-skill");
    is("Hello", "hello");
    is("Hello unicode: ", "hello-unicode-%EF%A3%BF");
    is("/Hello/there/", "hello/there");
    is("Hello/THIS/IS/SHIT", "hello/this/is/shit");
    is("Hello This Is Me", "hello-this-is-me");
    is("Hello?=l&=o", "hello");
    is("123", "123");
    is("1-2-3-4", "1-2-3-4");
    is("12 34", "12-34");
    is("f/ü/k", "f/%C3%BC/k");
    is("微博", "%E5%BE%AE%E5%8D%9A");

    is("/[design]/abc", "design/abc");

    is("/[design](foo)/apple bc", "design-foo/apple-bc");

    is(
      "remove object replacement character: ￼",
      "remove-object-replacement-character"
    );

    is(
      "Review of “The Development of William Butler Yeats” by V. K. Narayana Menon",
      "review-of-the-development-of-william-butler-yeats-by-v-k-narayana-menon"
    );
    is(
      "Review of The Development of William Butler Yeats by V. K. Narayana Menon Review of The Development offff William Butler Yeats by V. K. Narayana Menon",
      "review-of-the-development-of-william-butler-yeats-by-v-k-narayana-menon-review-of-the-development"
    );
    is(
      "AppleScript/Automator Folder Action to Convert Excel to CSV",
      "applescript/automator-folder-action-to-convert-excel-to-csv"
    );

    is(
      "Peter Gregson – Bach recomposed: 6.6 Gigue",
      "peter-gregson-bach-recomposed-6-6-gigue"
    );
    is(
      "Apple's Striking Short Film Ahead of International Day of People with Disabilities",
      "apples-striking-short-film-ahead-of-international-day-of-people-with-disabilities"
    );
    is("'xsb' command line error.", "xsb-command-line-error");
    is("Foo & bar", "foo-bar");
    is("Foo's bar", "foos-bar");
    is("Foo's Shouldn't Couldn't Wouldn't Don't", "foos-shouldnt-couldnt-wouldnt-dont");
    is("''s bar", "s-bar");
    is("'so' bar", "so-bar");
    is("Foo &amp; bar", "foo-and-bar");
    is("Foo&thinsp;bar", "foo-bar");
    is("China ← NYC → China", "china-from-nyc-to-china");
    is("China+()[] ← NYC! → China", "china-from-nyc-to-china");
    is("No more cd ../../", "no-more-cd");

    is(
      "«&nbsp;French Tech Communauté&nbsp;»&nbsp;: quelle opportunité pour l’État&nbsp;?",
      "french-tech-communaut%C3%A9-quelle-opportunit%C3%A9-pour-l-%C3%A9tat"
    );
  });

  it("does not throw when truncation would split a surrogate pair", function () {
    const emoji = "😀"; // one code point, two UTF-16 units
    // MAX_LENGTH + 10 is 110; 109 ASCII chars + emoji is 111 units
    const input = "a".repeat(109) + emoji;

    expect(function () {
      encodeURI(input.slice(0, 110));
    }).toThrowError(URIError);

    expect(function () {
      makeSlug(input);
    }).not.toThrow();

    const result = makeSlug(input);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("does not throw on a long string of supplementary-plane characters", function () {
    const input = "😀".repeat(80);
    expect(function () {
      makeSlug(input);
    }).not.toThrow();
    expect(typeof makeSlug(input)).toBe("string");
  });
});
