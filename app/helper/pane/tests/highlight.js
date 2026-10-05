// lib/highlight.js: highlight.js output as one HTML string per line, in a few short token classes,
// and the plain fallbacks (unknown language, highlight.js missing).
const cheerio = require("cheerio");
const { highlight, resolve, TOKENS, TOKEN_CLASSES } = require("../lib/highlight");

const text = (html) => cheerio.load(`<div>${html}</div>`, null, false)("div").text();

describe("pane highlight", function () {
  it("maps every highlight.js scope to one of a few token classes", function () {
    expect(TOKEN_CLASSES.length).toBeLessThanOrEqual(10);
    for (const cls of Object.values(TOKENS)) expect(TOKEN_CLASSES).toContain(cls);
  });

  it("returns one string per source line, with the source's text exactly", function () {
    const source = '<!doctype html>\n<p class="a">Hello &amp; <b>bye</b></p>\n\n  indented\n';
    const { lines, language } = highlight(source, "html");
    expect(language).toBe("html");
    expect(lines.length).toBe(source.split("\n").length);
    expect(lines.map(text).join("\n")).toBe(source);
  });

  it("uses the short token classes and no highlight.js class names", function () {
    const { lines } = highlight('<a href="/x">y</a>', "html");
    expect(lines[0]).toContain('class="pane-t-t"');
    expect(lines[0]).toContain('class="pane-t-a"');
    expect(lines[0]).toContain('class="pane-t-s"');
    expect(lines[0]).not.toContain("hljs");
  });

  it("closes and reopens a token that spans lines, so no span crosses a line break", function () {
    const { lines } = highlight("/* one\ntwo\nthree */\nvar a = 1;", "javascript");
    expect(lines.length).toBe(4);
    lines.forEach((l) => {
      const opens = (l.match(/<span/g) || []).length;
      const closes = (l.match(/<\/span>/g) || []).length;
      expect(opens).toBe(closes);
    });
    expect(lines[1]).toContain('class="pane-t-c"');
    expect(lines.map(text).join("\n")).toBe("/* one\ntwo\nthree */\nvar a = 1;");
  });

  it("escapes what it shows: markup in the code is text", function () {
    const { lines } = highlight('<script>alert("x")</script>', "html");
    expect(lines.join("")).not.toMatch(/<script/i);
    expect(text(lines[0])).toBe('<script>alert("x")</script>');
    const plain = highlight("<img src=x onerror=alert(1)>", "text");
    expect(plain.lines[0]).toBe("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("is deterministic", function () {
    const a = highlight("body { color: red }", "css");
    expect(highlight("body { color: red }", "css")).toEqual(a);
  });

  it("shows unknown languages and plain text as plain escaped lines, with a warning for unknown ones", function () {
    spyOn(console, "warn");
    expect(highlight("a <b>\nc", "klingon-9")).toEqual({ lines: ["a &lt;b&gt;", "c"], language: null });
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(highlight("a\nb", "plaintext")).toEqual({ lines: ["a", "b"], language: null });
    expect(highlight("a", "not a language!")).toEqual({ lines: ["a"], language: null });
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it("defaults to html and normalises CRLF", function () {
    expect(highlight("<p>x</p>").language).toBe("html");
    expect(highlight("a\r\nb\rc", "text").lines).toEqual(["a", "b", "c"]);
  });

  it("resolves language names and aliases, case-insensitively", function () {
    expect(resolve("HTML")).toBe("html");
    expect(resolve("js")).toBe("js");
    expect(resolve("text")).toBe("plain");
    expect(resolve("nope")).toBeNull();
    expect(resolve("<>")).toBeNull();
  });

  it("falls back to plain escaped text, with a warning, when highlight.js cannot be loaded", function () {
    const Module = require("module");
    const load = Module._load;
    spyOn(console, "warn");
    // a fresh copy of the module in which require("highlight.js") fails
    const file = require.resolve("../lib/highlight");
    delete require.cache[file];
    Module._load = function (request) {
      if (request === "highlight.js") throw new Error("Cannot find module 'highlight.js'");
      return load.apply(this, arguments);
    };
    try {
      const fresh = require("../lib/highlight");
      expect(fresh.highlight("<p>x</p>\ny", "html")).toEqual({ lines: ["&lt;p&gt;x&lt;/p&gt;", "y"], language: null });
      fresh.highlight("z", "html"); // warns once, not per call
      expect(console.warn.calls.allArgs().filter((a) => /highlight\.js is not available/.test(a[0])).length).toBe(1);
    } finally {
      Module._load = load;
      delete require.cache[file];
      require("../lib/highlight");
    }
  });
});
