const pane = require("../index");
const options = require("../lib/options");

describe("pane unknown options", function () {
  let warn;
  beforeEach(function () {
    options.reset();
    warn = spyOn(console, "warn");
  });

  const messages = () => warn.calls.allArgs().map((a) => a[0]);

  it("warns once per unknown key and still renders", function () {
    const first = pane.folder("a.txt", { iconsize: "large" });
    expect(first.html).toContain("pane");
    pane.folder("a.txt", { iconsize: "large" });
    expect(messages().length).toBe(1);
    expect(messages()[0]).toContain('unknown option "iconsize"');
    expect(messages()[0]).toContain('did you mean "iconSize"');
  });

  it("warns for each unknown key, and separately per function", function () {
    pane.folder("a.txt", { colour: "red", size: 2 });
    pane.text("hi", { colour: "red" });
    expect(messages().length).toBe(3);
  });

  it("points `selected` at the row attribute", function () {
    pane.folder("a.txt", { selected: ["a.txt"] });
    expect(messages()[0]).toContain("[selected]");
  });

  it("covers text, code and browser, and never throws", function () {
    expect(() => {
      pane.text("hi", { lang: "x" });
      pane.code("hi", { lang: "x" });
      pane.browser({ html: "<p>hi</p>", now: "2026-01-01T00:00:00" });
    }).not.toThrow();
    const text = messages().join("\n");
    expect(text).toContain("pane.text");
    expect(text).toContain("pane.code");
    // the browser shows no dates
    expect(text).toContain('"now" for pane.browser');
  });

  it("is silent for every accepted key", function () {
    pane.folder("a.txt", {
      title: "T",
      view: "list",
      files: {},
      now: "2026-01-01T00:00:00",
      os: "mac",
      theme: "dark",
      width: "300px",
      height: "200px",
      iconSize: "large",
      toolbar: "view",
    });
    pane.text("hi", { title: "T", chrome: false, highlight: true });
    pane.code("hi", { language: "html" });
    pane.browser({ url: "example.com", html: "<p>hi</p>", tint: "#eee" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn for a missing (undefined) option", function () {
    pane.folder("a.txt", { view: undefined, whatever: undefined });
    expect(warn).not.toHaveBeenCalled();
  });

  it("lists the accepted keys in one place", function () {
    expect(options.ACCEPTED.folder).toContain("iconSize");
    expect(options.ACCEPTED.code).toContain("language");
    expect(options.ACCEPTED.browser).toContain("tint");
  });

  it("stays quiet for the docs build's blocks of every kind", function () {
    const cheerio = require("cheerio");
    const $ = cheerio.load(
      '<pre class="folder" data-icon-size="large">a.txt</pre><pre class="text">hi</pre><pre class="code javascript">var a</pre><pre class="browser" data-url="example.com"><p>hi</p></pre>'
    );
    pane.transform($, { now: "2026-01-01T00:00:00" });
    expect(warn).not.toHaveBeenCalled();
  });
});
