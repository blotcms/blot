// The editor windows (pane.text, pane.code): the DOM contract in DESIGN.md "Editor windows",
// the authoring syntax handled by transform, and the macOS skin's wiring.
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const css = require("../lib/css");
const pane = require("../index");

const $html = (html) => cheerio.load(html, { decodeEntities: false }, false);

describe("pane editor windows", function () {
  describe("text", function () {
    it("is one figure named by its title, with aria-hidden chrome and the text in a pre", function () {
      const $ = $html(pane.text("Hello", { title: "Post.txt" }).html);
      expect($("figure.pane.pane-ed[data-view=text]").length).toBe(1);
      expect($("figure").attr("aria-label")).toBe("Post.txt");
      expect($(".pane-bar").text()).toBe("Post.txt");
      expect($("[aria-hidden=true]").length).toBe(2); // the bar and the head
      expect($("pre.pane-body").text()).toBe("Hello");
      expect($("pre.pane-body").attr("tabindex")).toBeUndefined();
    });

    it("keeps whitespace and line breaks exactly", function () {
      const source = "  indented\n\n\ttabbed   and   spaced\ntrailing  \n";
      expect($html(pane.text(source).html)("pre.pane-body").text()).toBe(source);
    });

    it("keeps a leading blank line (a pre would drop the first newline)", function () {
      expect($html(pane.text("\nfirst").html)("pre.pane-body").text()).toBe("\nfirst");
    });

    it("escapes everything and never interprets markup", function () {
      const nasty = '<script>alert(1)</script><img src=x onerror=alert(1)> & "q" {{name}} &lt;';
      const html = pane.text(nasty, { title: '"><script>x</script>' }).html;
      expect(html).not.toMatch(/<script|<img/i);
      const $ = $html(html);
      expect($("script, img").length).toBe(0);
      expect($("pre.pane-body").text()).toBe(nasty);
      expect($("figure").attr("aria-label")).toBe('"><script>x</script>');
    });

    it("is titled Text by default and normalises CRLF", function () {
      const $ = $html(pane.text("a\r\nb").html);
      expect($("figure").attr("aria-label")).toBe("Text");
      expect($("pre").text()).toBe("a\nb");
    });

    it("chrome:false is the text panel alone: no bar, no head, a pane-bare window", function () {
      const $ = $html(pane.text("x", { chrome: false }).html);
      expect($("figure").hasClass("pane-bare")).toBe(true);
      expect($(".pane-bar, .pane-head").length).toBe(0);
      expect($("figure").attr("aria-label")).toBe("Text");
    });

    it("makes the body a named scroller only when it can scroll", function () {
      const short = $html(pane.text("a\nb\nc").html);
      expect(short("pre").attr("tabindex")).toBeUndefined();
      const long = $html(pane.text(Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"), { title: "Long.txt" }).html);
      expect(long("pre").attr("tabindex")).toBe("0");
      expect(long("pre").attr("aria-label")).toBe("Long.txt");
      const wrapped = $html(pane.text(("word ".repeat(40) + "\n").repeat(6)).html); // wraps to more than fits
      expect(wrapped("pre").attr("tabindex")).toBe("0");
      expect($html(pane.text("a", { height: "120px" }).html)("pre").attr("tabindex")).toBe("0");
    });

    it("takes width and height as custom properties, and pins as the folder does", function () {
      const html = pane.text("a", { width: "320px", height: "200px", theme: "dark", os: "mac" }).html;
      expect(html).toContain('style="--pane-w:320px;--pane-h:200px"');
      expect(html).toContain('data-theme="dark"');
      expect(html).toContain('data-pin="mac"');
    });

    it("drops a pin for an OS without a skin, with a warning, like the folder window", function () {
      spyOn(console, "warn");
      const original = css.SKINS.slice();
      css.SKINS.splice(0, css.SKINS.length, "mac");
      try {
        expect(pane.text("a", { os: "win" }).html).not.toContain("data-pin");
        expect(console.warn).toHaveBeenCalled();
      } finally {
        css.SKINS.splice(0, css.SKINS.length, ...original);
      }
    });

    it("never throws for author input", function () {
      spyOn(console, "warn");
      for (const bad of [undefined, null, 42, {}, [], String.fromCharCode(0, 0xd800)]) {
        expect(() => pane.text(bad, null)).not.toThrow();
        expect(() => pane.code(bad, { language: bad, title: bad, width: bad })).not.toThrow();
      }
      expect(pane.text(undefined).html).toContain("pane-body");
    });

    it("is deterministic and reads no clock", function () {
      expect(pane.text("x", { title: "a" }).html).toBe(pane.text("x", { title: "a", now: "2030-01-01T00:00:00" }).html);
    });
  });

  describe("code", function () {
    const SOURCE = '<!doctype html>\n<p class="intro">Hello &amp; bye</p>\n\n  <a href="/x">y</a>';

    it("wraps every line in a pane-l span, joined by real newlines, and keeps the text exact", function () {
      const $ = $html(pane.code(SOURCE, { title: "Snippet.txt" }).html);
      expect($("pre.pane-body > code > .pane-l").length).toBe(4);
      expect($("pre.pane-body").text()).toBe(SOURCE); // no line numbers, no extra whitespace
      expect($(".pane-l").toArray().some((l) => $(l).text().includes("\n"))).toBe(false);
    });

    it("highlights html by default, with token spans in short classes", function () {
      const html = pane.code('<p class="a">x</p>').html;
      expect(html).toContain('data-lang="html"');
      expect(html).toMatch(/pane-t-[ktas]/);
      expect(html).not.toContain("hljs");
    });

    it("takes a language, and shows unknown languages and plain text without tokens", function () {
      spyOn(console, "warn");
      expect(pane.code("var a = 1;", { language: "javascript" }).html).toContain('data-lang="javascript"');
      const plain = pane.code("var a = 1;", { language: "klingon" }).html;
      expect(plain).not.toContain("pane-t-");
      expect(plain).not.toContain("data-lang");
      expect(pane.code("<b>", { language: "text" }).html).not.toContain("pane-t-");
    });

    it("escapes everything, also in a plain window", function () {
      for (const language of ["html", "text"]) {
        const html = pane.code("<script>alert(1)</script><img src=x onerror=1>", { language }).html;
        expect(html).not.toMatch(/<script|<img/i);
        expect($html(html)("pre").text()).toBe("<script>alert(1)</script><img src=x onerror=1>");
      }
    });

    it("has no title text without a title (the window is still named), and a bar with one", function () {
      const bare = $html(pane.code("x").html);
      expect(bare("figure").attr("aria-label")).toBe("Code");
      expect(bare(".pane-bar").text()).toBe("");
      expect($html(pane.code("x", { title: "a.html" }).html)(".pane-bar").text()).toBe("a.html");
    });

    it("is a named scroller when a line is long or there are many lines", function () {
      expect($html(pane.code("<p>", { title: "A.html" }).html)("pre").attr("tabindex")).toBeUndefined();
      const wide = $html(pane.code("x".repeat(60), { title: "Wide.html" }).html)("pre");
      expect(wide.attr("tabindex")).toBe("0");
      expect(wide.attr("aria-label")).toBe("Wide.html");
      expect($html(pane.code(Array(30).fill("x").join("\n")).html)("pre").attr("tabindex")).toBe("0");
    });

    it("always has line spans, for a skin that shows a gutter; the counters are CSS", function () {
      const { css: sheet } = pane.assets();
      expect(sheet).toContain(".pane-l{counter-increment:pane-line}");
      expect(sheet).toContain("content:counter(pane-line)");
      expect(sheet).toMatch(/\.pane-l::before\{[^}]*user-select:none/);
    });
  });

  describe("transform", function () {
    const run = (markup, options) => {
      const $ = cheerio.load(markup, { decodeEntities: false }, false);
      pane.transform($, options);
      return $;
    };

    it("replaces pre.text and pre.code with windows, and only they", function () {
      const $ = run('<pre class="text" title="Post.txt"><code>Hello</code></pre><pre class="code"><code>&lt;p&gt;</code></pre><p>after</p>');
      expect($("pre.text, pre.code").length).toBe(0);
      expect($("figure.pane").length).toBe(2);
      expect($("figure[data-view=text]").attr("aria-label")).toBe("Post.txt");
      expect($("figure[data-view=code] pre").text()).toBe("<p>");
      expect($("p").text()).toBe("after");
    });

    it("shows a text window's chrome only with with-chrome (or data-chrome), a code window's always", function () {
      const $ = run(
        '<pre class="text" title="a"><code>x</code></pre>' +
          '<pre class="text with-chrome" title="b"><code>x</code></pre>' +
          '<pre class="text" data-chrome="true" title="c"><code>x</code></pre>' +
          '<pre class="code"><code>x</code></pre>' +
          '<pre class="code" data-chrome="false"><code>x</code></pre>'
      );
      const bare = $("figure").map((i, el) => $(el).hasClass("pane-bare")).get();
      expect(bare).toEqual([true, false, false, false, true]);
    });

    it("reads the title from title, and the language from a class or data-language", function () {
      const $ = run('<pre class="code javascript" title="a.js">var a;</pre><pre class="code" data-language="css">a{}</pre><pre class="code"><code>&lt;p&gt;</code></pre>');
      expect($("figure").eq(0).attr("data-lang")).toBe("javascript");
      expect($("figure").eq(0).attr("aria-label")).toBe("a.js");
      expect($("figure").eq(1).attr("data-lang")).toBe("css");
      expect($("figure").eq(2).attr("data-lang")).toBe("html");
    });

    it("takes the text of already highlighted code (the docs' hljs pass runs first)", function () {
      const $ = run('<pre class="code javascript"><code class="hljs"><span class="hljs-keyword">var</span> a = <span class="hljs-number">1</span>;</code></pre>');
      expect($("figure pre").text()).toBe("var a = 1;");
    });

    it("trims leading newlines and trailing space like the folder, but keeps the inside", function () {
      const $ = run('<pre class="text"><code>\n\n  a\n\n  b  \n\n</code></pre>');
      expect($("figure pre").text()).toBe("  a\n\n  b");
    });

    it("passes width, height, os and theme, and never throws on odd attributes", function () {
      const $ = run('<pre class="text" data-width="300px" data-height="150px" data-os="mac" data-theme="dark" data-chrome="maybe"><code>x</code></pre>');
      expect($("figure").attr("style")).toBe("--pane-w:300px;--pane-h:150px");
      expect($("figure").attr("data-pin")).toBe("mac");
      expect($("figure").attr("data-theme")).toBe("dark");
    });
  });

  describe("macOS skin", function () {
    const source = fs.readFileSync(path.join(__dirname, "..", "css", "mac-editor.css"), "utf8");
    const built = pane.assets().css;

    it("is part of the mac skin's stylesheet, with icons inlined", function () {
      expect(built).toContain("pane-ed");
      expect(built).not.toContain("icon:mac");
      expect(source).not.toMatch(/\.png|\.jpg|image\/png/);
    });

    it("has light and dark tokens for the editor, and a token palette (plain, as TextEdit is)", function () {
      const skin = css.skin("mac", source);
      expect(skin).toMatch(/--ed-fg:#000;[^}]*color-scheme:light/);
      expect(skin).toMatch(/--ed-fg:#fff;[^}]*color-scheme:dark/);
      for (const t of ["k", "s", "c", "n", "f", "a", "t", "m", "y", "v"]) {
        expect(source).toContain(`--tok-${t}:`);
        expect(built).toContain(`.pane-t-${t}{color:var(--tok-${t},inherit)}`);
      }
    });

    it("has an opt-in palette: highlight:true adds pane-hl (only when the code is highlighted)", function () {
      expect(pane.code("<p>", { highlight: true }).html).toContain("pane-ed pane-hl");
      expect(pane.code("<p>").html).not.toContain("pane-hl");
      expect(pane.code("<p>", { highlight: true, language: "text" }).html).not.toContain("pane-hl");
      expect(built).toContain(".pane-hl{--tok-k:#ad3da4");
      expect(pane.text("x", { highlight: true }).html).not.toContain("pane-hl");
    });

    it("writes every selector against .pane, so the build roots it", function () {
      expect(() => css.skin("mac", source)).not.toThrow();
    });
  });
});
