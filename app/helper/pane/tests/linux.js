// The GNOME Files skin: how it is wired in, and that the markup gives it what the reference shows.
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const css = require("../lib/css");
const { EXTENSIONS } = require("../lib/format");
const pane = require("../index");

const SOURCE = fs.readFileSync(path.join(__dirname, "..", "css", "linux.css"), "utf8");
const NOW = "2026-09-20T15:38:00";
const FILES = {
  "About.txt": { bytes: 6, modified: "2026-09-20T09:12:00" },
  "Animation.gif": { bytes: 2700, modified: "2026-08-14T10:00:00" },
  "Blot.webloc": { bytes: 128, modified: "2026-04-25T10:00:00" },
};
const TREE = "About.txt\nAnimation.gif\nBlot.webloc\nFruits\n  Apple.md";
const cells = ($, row, cls) => $(row).find(`.${cls} > [data-os=linux]`).text();

describe("pane GNOME Files skin", function () {
  it("is a built skin, so Linux visitors no longer fall back to macOS", function () {
    expect(css.SKINS).toContain("linux");
    const html = pane.folder(TREE, { files: FILES, now: NOW }).html;
    const visitor = (os) => cheerio.load(`<html data-os="${os}"><body>${html}</body></html>`);
    expect(visitor("linux")(css.group("linux")).length).toBe(1);
    expect(visitor("linux")(css.group("mac")).length).toBe(0);
    // a visitor with no skin at all (or none yet) still gets the default one
    expect(visitor("bsd")(css.group("mac")).length).toBe(1);
    expect(visitor("bsd")(css.group("linux")).length).toBe(0);
  });

  it("emits its rules only for data-os=linux and data-pin=linux, never the fallback", function () {
    const out = css.skin("linux", SOURCE);
    expect(css.group("linux")).toBe(":is(html[data-os=linux] .pane:not([data-pin]),.pane[data-pin=linux])");
    expect(out).toContain(`${css.group("linux")} .pane-bar::before{`);
    expect(out).not.toContain("html:not(");
    // every top-level selector in the built skin starts with the group
    const selectors = css.items(out).filter((it) => it.sel && !it.sel.startsWith("@")).map((it) => it.sel);
    expect(selectors.length).toBeGreaterThan(30);
    for (const sel of selectors) expect(sel.startsWith(css.group("linux"))).toBe(true);
  });

  it("has real light and dark tokens (libadwaita), for prefers-color-scheme and a pinned theme", function () {
    const out = css.skin("linux", SOURCE);
    expect(out).toMatch(/--bg:#fff;[^}]*color-scheme:light\}/);
    expect(out).toMatch(/prefers-color-scheme:dark\)\{[^]*:not\(\[data-theme=light\]\)\{--bg:#1e1e1e;[^}]*color-scheme:dark\}/);
    expect(out).toMatch(/\[data-theme=dark\]\{--bg:#1e1e1e;[^}]*color-scheme:dark\}/);
  });

  it("honours an os:\"linux\" pin (no warning) and emits only the Linux text", function () {
    spyOn(console, "warn");
    const html = pane.folder(TREE, { files: FILES, now: NOW, os: "linux" }).html;
    expect(console.warn).not.toHaveBeenCalled();
    expect(html).toContain('data-pin="linux"');
    expect(html).not.toMatch(/data-os="(mac|win)"/);
    expect(cheerio.load(html)(".pane-t").length).toBe(0); // GNOME's default columns have no Type
  });

  describe("columns and formats (Name, Size, Modified)", function () {
    const $ = cheerio.load(pane.folder(TREE, { files: FILES, now: NOW, os: "linux" }).html);
    const rows = $(".pane-row").toArray();

    it("writes sizes 1000-based and folders as a count of items", function () {
      expect(cells($, rows[0], "pane-s")).toBe("6 bytes");
      expect(cells($, rows[1], "pane-s")).toBe("2.7 kB");
      expect(cells($, rows[2], "pane-s")).toBe("128 bytes");
      expect(cells($, rows[3], "pane-s")).toBe("1 item");
    });

    it("writes Today 9:12 and 14 Aug 2026 dates", function () {
      expect(cells($, rows[0], "pane-d")).toBe("Today 9:12");
      expect(cells($, rows[1], "pane-d")).toBe("14 Aug 2026");
      expect(cells($, rows[2], "pane-d")).toBe("25 Apr 2026");
    });

    it("keeps Windows' hidden extensions out of a pinned window", function () {
      expect($(".pane-x").length).toBe(0);
      expect($(rows[0]).find(".pane-label").text()).toBe("About.txt");
    });

    it("orders Size before Modified and labels the columns in the CSS", function () {
      expect(SOURCE).toMatch(/\.pane \.pane-s\{[^}]*order:1/);
      expect(SOURCE).toMatch(/\.pane \.pane-d\{[^}]*order:2/);
      expect(SOURCE).toMatch(/i:nth-child\(3\)::before\{content:"Size"\}/);
      expect(SOURCE).toMatch(/i:nth-child\(2\)::before\{content:"Modified"\}/);
      expect(SOURCE).toMatch(/i:nth-child\(1\)::before\{content:"Name"\}/);
    });
  });

  it("draws every kind of icon the markup can emit, as SVG", function () {
    const kinds = new Set(["folder", "generic", ...Object.values(EXTENSIONS).map((e) => e.kind).filter(Boolean)]);
    const out = css.build();
    for (const kind of kinds) expect(SOURCE).toContain(`.pane-k-${kind}`);
    expect(out).not.toContain("icon:");
    expect(out).not.toMatch(/image\/png/);
    // the Adwaita document icon is what .doc and .docx show
    expect(SOURCE).toMatch(/\.pane-k-md,\.pane \.pane-k-doc\{/);
  });
});
