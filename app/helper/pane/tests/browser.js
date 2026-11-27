const cheerio = require("cheerio");
const pane = require("../index");
const css = require("../lib/css");
const { parseUrl } = require("../lib/browser");

const dom = (html) => cheerio.load(html);

describe("pane browser window", function () {
  let warn;
  beforeEach(function () {
    warn = spyOn(console, "warn");
  });

  it("is one figure, named by the title, with aria-hidden chrome and an address field", function () {
    const $ = dom(
      pane.browser({
        url: "https://example.com/",
        html: "<h1>Hi</h1>",
        title: "Example Domain",
      }).html
    );
    const fig = $("figure.pane.pane-br");
    expect(fig.length).toBe(1);
    expect(fig.attr("data-view")).toBe("browser");
    expect(fig.attr("aria-label")).toBe("Example Domain");
    for (const sel of [".pane-bar", ".pane-head", ".pane-url"])
      expect(fig.children(sel).attr("aria-hidden")).toBe("true");
    expect(fig.find(".pane-bar .pane-tab").text()).toBe("Example Domain");
    expect(fig.children(".pane-page").children("iframe").length).toBe(1);
  });

  it("splits the address into parts a skin can show or hide", function () {
    const $ = dom(
      pane.browser({ url: "https://www.example.com:8080/a/b?x=1#y" }).html
    );
    const part = (c) => $(`.pane-url .${c}`).text();
    expect(part("pane-u-s")).toBe("https://");
    expect(part("pane-u-w")).toBe("www.");
    expect(part("pane-u-h")).toBe("example.com:8080");
    expect(part("pane-u-p")).toBe("/a/b?x=1#y");
    expect($(".pane-u-r").length).toBe(0);
    expect($("figure").attr("data-secure")).toBe("true");
    // the root path is marked, so a skin can drop the lone slash
    expect(
      dom(pane.browser({ url: "example.com" }).html)(".pane-u-r").text()
    ).toBe("/");
    expect(
      dom(pane.browser({ url: "http://example.com/" }).html)("figure").attr(
        "data-secure"
      )
    ).toBe("false");
  });

  it("parses addresses without throwing", function () {
    expect(parseUrl("")).toBe(null);
    expect(parseUrl("blot.im").scheme).toBe("https://");
    expect(parseUrl("about:blank")).toEqual({ text: "about:blank" });
    expect(parseUrl("https://")).toEqual({ text: "https://" });
    expect(() => pane.browser({ url: "ht!tp://%%%" })).not.toThrow();
    expect(() => pane.browser()).not.toThrow();
  });

  it("names the window after the host when there is no title", function () {
    const $ = dom(pane.browser({ url: "https://www.example.com/" }).html);
    expect($("figure").attr("aria-label")).toBe("www.example.com");
  });

  it("shows static html in a sandboxed srcdoc iframe with no scripts", function () {
    const $ = dom(
      pane.browser({
        url: "example.com",
        html: '<p onclick="x()">a "quoted" &amp; <b>page</b></p>',
      }).html
    );
    const frame = $("iframe");
    expect(frame.attr("sandbox")).toBe(
      "allow-popups allow-popups-to-escape-sandbox"
    );
    expect(frame.attr("sandbox")).not.toContain("allow-scripts");
    expect(frame.attr("src")).toBeUndefined();
    const doc = frame.attr("srcdoc");
    expect(doc).toContain("<!doctype html>");
    expect(doc).toContain('<base target="_blank">');
    expect(doc).toContain('a "quoted" &amp; <b>page</b>');
    expect(frame.attr("title")).toBe("example.com, page");
  });

  it("keeps a full document's own head, adding only the base", function () {
    const doc = dom(
      pane.browser({
        html: "<!doctype html><html><head><title>T</title></head><body>x</body></html>",
      }).html
    )("iframe").attr("srcdoc");
    expect(doc.match(/<!doctype/gi).length).toBe(1);
    expect(doc).toContain('<head><base target="_blank">');
  });

  it("shows a live src in a lazy, sandboxed iframe without allow-same-origin", function () {
    const $ = dom(
      pane.browser({ src: "https://example.org/page?a=1&b=2", title: "Live" })
        .html
    );
    const frame = $("iframe");
    expect(frame.attr("src")).toBe("https://example.org/page?a=1&b=2");
    expect(frame.attr("loading")).toBe("lazy");
    expect(frame.attr("sandbox")).toContain("allow-scripts");
    expect(frame.attr("sandbox")).not.toContain("allow-same-origin");
    expect(frame.attr("title")).toBe("Live, page");
    // the address defaults to the src
    expect($(".pane-u-h").text()).toBe("example.org");
  });

  it("lets html win over src, and drops a src that is not http(s)", function () {
    let $ = dom(
      pane.browser({ html: "<p>x</p>", src: "https://example.org/" }).html
    );
    expect($("iframe").attr("srcdoc")).toContain("<p>x</p>");
    expect($("iframe").attr("src")).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.calls.reset();
    $ = dom(pane.browser({ src: "javascript:alert(1)", url: "a.com" }).html);
    expect($("iframe").length).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it("has an empty page when given neither", function () {
    expect(dom(pane.browser({ url: "a.com" }).html)(".pane-page").html()).toBe(
      ""
    );
  });

  it("takes size, theme and tint, and ignores a tint that is not a colour", function () {
    const $ = dom(
      pane.browser({
        url: "a.com",
        width: "500px",
        height: "300px",
        theme: "dark",
        tint: "#eee",
      }).html
    );
    expect($("figure").attr("style")).toBe(
      "--pane-w:500px;--pane-h:300px;--br-tint:#eee"
    );
    expect($("figure").attr("data-theme")).toBe("dark");
    expect(
      dom(pane.browser({ url: "a.com", tint: "red;}x{" }).html)("figure").attr(
        "style"
      )
    ).toBeUndefined();
  });

  it("escapes author text everywhere", function () {
    const html = pane.browser({
      url: 'a.com/"><script>',
      title: '"><img src=x>',
    }).html;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
  });

  describe("skins", function () {
    it("is built for macOS, Windows and Linux, so none falls back to another", function () {
      expect(css.viewsOf("mac")).toContain("browser");
      expect(css.viewsOf("win")).toContain("browser");
      expect(css.viewsOf("linux")).toContain("browser");
      expect(css.group("mac")).not.toContain(
        "html[data-os=win] .pane[data-view=browser]:not([data-pin])"
      );
      expect(css.group("mac")).not.toContain(
        "html[data-os=linux] .pane[data-view=browser]:not([data-pin])"
      );
      expect(css.group("win")).not.toContain(":not([data-view=browser])");
      expect(css.group("linux")).not.toContain(":not([data-view=browser])");
    });

    it("keeps an os pin that has a browser skin (mac, win, linux) and drops an unknown one", function () {
      let $ = dom(pane.browser({ url: "a.com", os: "beos" }).html);
      expect($("figure").attr("data-pin")).toBeUndefined();
      expect(warn).toHaveBeenCalled();
      $ = dom(pane.browser({ url: "a.com", os: "mac" }).html);
      expect($("figure").attr("data-pin")).toBe("mac");
      $ = dom(pane.browser({ url: "a.com", os: "win" }).html);
      expect($("figure").attr("data-pin")).toBe("win");
      $ = dom(pane.browser({ url: "a.com", os: "linux" }).html);
      expect($("figure").attr("data-pin")).toBe("linux");
    });

    it("ships the macOS, Windows and Linux skins' rules and glyphs in the one stylesheet", function () {
      const { css: out } = pane.assets();
      expect(out).toContain(".pane-url");
      expect(out).toContain("--br-bar:");
      expect(out).toContain("--br-strip:");
      expect(out).not.toContain("icon:mac");
      expect(out).not.toContain("icon:win");
      expect(out).not.toContain("icon:linux");
    });
  });

  describe("transform", function () {
    it("turns pre.browser into a window: the text is the page, attributes are the options", function () {
      const $ = dom(
        '<pre class="browser" data-url="https://example.com/" title="Example" data-tint="#eee" data-width="400px"><code>&lt;h1&gt;Hello&lt;/h1&gt;</code></pre>'
      );
      pane.transform($);
      expect($("pre").length).toBe(0);
      expect($("figure.pane-br").attr("aria-label")).toBe("Example");
      expect($("figure").attr("style")).toContain("--pane-w:400px");
      expect($("iframe").attr("srcdoc")).toContain("<h1>Hello</h1>");
      expect($(".pane-u-h").text()).toBe("example.com");
    });

    it("shows a live site for data-src, ignoring the text", function () {
      const $ = dom(
        '<pre class="browser" data-src="https://example.org/">ignored</pre>'
      );
      pane.transform($);
      expect($("iframe").attr("src")).toBe("https://example.org/");
      expect($("iframe").attr("srcdoc")).toBeUndefined();
    });
  });
});
