const pane = require("../index");
const { expand } = require("../lib/names");
const cheerio = require("cheerio");

describe("pane-name", function () {
  it("expands a term to one child per OS", function () {
    expect(expand("Finder")).toBe('<span data-os="mac">Finder</span><span data-os="win">File Explorer</span><span data-os="linux">Files</span>');
  });
  it("finds a term by any OS's spelling, or by data-key, and keeps the first letter's case", function () {
    expect(expand("recycle bin")).toContain('<span data-os="mac">trash</span>');
    expect(expand("x", "trash")).toContain("Recycle Bin".replace("R", "r"));
    expect(expand("Trash")).toContain('data-os="win">Recycle Bin');
  });
  it("leaves an unknown term alone", function () {
    expect(expand("Nautilus")).toBeNull();
  });
  it("is expanded by transform and shown by the same data-os CSS", function () {
    const $ = cheerio.load('<p>Open <span class="pane-name">Finder</span> and <span class="pane-name">Nope</span>.</p>', { decodeEntities: false }, false);
    spyOn(console, "warn");
    pane.transform($);
    expect($("span.pane-name").first().children().length).toBe(3);
    expect($("span.pane-name").last().text()).toBe("Nope");
    expect(console.warn).toHaveBeenCalled();
    const css = pane.assets().css;
    const unbuilt = require("../lib/css").unbuilt(require("../lib/css").SKINS);
    expect(css).toContain(`html[data-os=mac] .pane-name>[data-os=mac],${unbuilt} .pane-name>[data-os=mac]`);
    expect(css).toContain("html[data-os=win] .pane-name>[data-os=win]");
  });
});
