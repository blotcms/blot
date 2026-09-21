// The Windows 11 skin (css/win.css): how it is wired into the build and what its markup shows.
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const css = require("../lib/css");
const pane = require("../index");

const TREE = "Fruits\n  Apple.md\nAbout.txt\nAnimation.gif\nBlot.webloc\nDraft.md\nindex.html\nReport.docx";
const win = css.group("win");

describe("pane Windows skin", function () {
  const source = fs.readFileSync(path.join(__dirname, "..", "css", "win.css"), "utf8");
  const built = css.skin("win", source);

  it("is built, so Windows visitors no longer fall back to the mac skin", function () {
    expect(css.SKINS).toContain("win");
    const { css: out } = pane.assets();
    expect(out).toContain("html[data-os=win] .pane:not([data-pin])");
    // the default (mac) skin's fallback excludes win
    expect(out).toContain(`${css.unbuilt(css.SKINS)} .pane:not([data-pin])`);
    expect(css.unbuilt(css.SKINS)).toContain("[data-os=win]");
    expect(out).not.toContain("html:not(:is([data-os=mac])) ");
  });

  it("emits its rules only through the data-os=win / data-pin=win path", function () {
    const selectors = [];
    const collect = (its) => its.forEach((i) => (i.sel && i.sel.startsWith("@") ? collect(css.items(i.body)) : i.sel && selectors.push(i.sel)));
    collect(css.items(built).filter((i) => i.sel));
    expect(selectors.length).toBeGreaterThan(50);
    // every selector of the skin starts with the win group (nothing leaks unrooted)
    expect(selectors.filter((s) => !s.split(/,(?=:is\()/).every((part) => part.startsWith(win))).length).toBe(0);
    // and never through the mac path
    expect(built).not.toContain("data-os=mac");
    expect(built).not.toContain("data-pin=mac");
  });

  it("has light and dark tokens", function () {
    expect(built).toMatch(/\{--bg:#fff;[^}]*color-scheme:light\}/);
    expect(built).toMatch(/@media \(prefers-color-scheme:dark\)\{[^]*:not\(\[data-theme=light\]\)\{--bg:#191919;[^}]*color-scheme:dark\}/);
    expect(built).toMatch(/\[data-theme=dark\]\{--bg:#191919;[^}]*color-scheme:dark\}/);
  });

  it("uses no bitmaps and inlines every icon", function () {
    const { css: out } = pane.assets();
    expect(source).not.toMatch(/\.png|\.jpg|image\/png/);
    expect(out).not.toContain("icon:win");
    for (const f of fs.readdirSync(path.join(__dirname, "..", "icons", "win"))) expect(f).toMatch(/\.svg$/);
  });

  it("draws every icon kind, .doc as the generic file", function () {
    for (const kind of ["folder", "text", "html", "image", "generic", "doc", "md", "link"]) expect(source).toContain(`.pane-k-${kind}`);
    expect(source).toMatch(/\.pane-k-doc[^{]*\{background-image:url\(icon:win\/generic\)\}/);
    expect(source).not.toContain("win/doc");
  });

  it("honours an os:\"win\" pin without warning", function () {
    spyOn(console, "warn");
    const html = pane.folder(TREE, { os: "win" }).html;
    expect(html).toContain('data-pin="win"');
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("shows the Type cell, hides the extension and puts the Type text in the win child", function () {
    expect(source).toMatch(/\.pane-t\{display:block/);
    expect(source).toContain(".pane-x{display:none}");
    expect(source).toContain(".pane [data-os=win]{display:inline}");
    const $ = cheerio.load(pane.folder(TREE).html);
    const row = (name) => $(".pane-row").filter((i, el) => $(el).find(".pane-label").text().startsWith(name)).first();
    expect(row("About").find(".pane-x").text()).toBe(".txt");
    expect(row("About").find(".pane-t").text()).toBe("Text Document");
    expect(row("Draft").find(".pane-x").length).toBe(0);
    expect(row("Draft").find(".pane-t").text()).toBe("MD File");
    expect(row("index").find(".pane-t").text()).toBe("Microsoft Edge HTML Document");
    expect(row("Fruits").find(".pane-t").text()).toBe("File folder");
    expect(row("Fruits").find(".pane-s [data-os=win]").text()).toBe("");
    expect(row("Report").find(".pane-k-doc").length).toBe(1);
  });

  it("sizes in KB with the win child of each size cell", function () {
    const $ = cheerio.load(pane.folder("a.md", { files: { "a.md": { bytes: 2049, modified: "2026-09-20T15:38:00" } }, now: "2026-09-20T16:00:00" }).html);
    expect($(".pane-s [data-os=win]").text()).toBe("3 KB");
    expect($(".pane-d [data-os=win]").text()).toBe("9/20/2026 3:38 PM");
  });

  it("adds no chrome elements and no drop shadow", function () {
    const $ = cheerio.load(pane.folder(TREE).html);
    expect($(".pane-bar, .pane-head, .pane-head i").length).toBe(5);
    expect(built).not.toMatch(/box-shadow:[^;}]*(rgba|#)/);
    expect(source).not.toContain("box-shadow");
  });

  it("copes with narrow windows, forced colours and keyboard scrolling", function () {
    expect(source).toContain("@container (max-width:439px)");
    expect(source).toContain("@media (forced-colors:active)");
    expect(pane.folder(TREE, { height: "300px" }).html).toContain('tabindex="0"');
  });
});
