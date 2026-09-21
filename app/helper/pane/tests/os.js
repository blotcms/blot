// Every visitor OS x every pin: exactly one skin applies and nothing is left hidden.
const cheerio = require("cheerio");
const css = require("../lib/css");
const { formatType, splitExtension } = require("../lib/format");
const pane = require("../index");

const VISITORS = [undefined, "mac", "win", "linux"];
const PINS = [undefined, "mac", "win", "linux"];
const FILES = { "About.txt": { bytes: 6, modified: "2026-09-20T15:38:00" } };
const TREE = "Fruits\n  Apple.md\nAbout.txt\nBlot.webloc";

// The skin(s) whose root selector matches the window, for a built list of skins.
function matching(visitor, html, skins) {
  const $ = cheerio.load(`<html${visitor ? ` data-os="${visitor}"` : ""}><body>${html}</body></html>`);
  return skins.filter((s) => $(css.group(s, skins)).length > 0);
}

// The cells a skin shows for a window: its date and size cells must have a child for it.
function visibleCells(html, skin) {
  const $ = cheerio.load(html);
  return $(".pane-d, .pane-s").toArray().every((c) => $(c).children(`[data-os=${skin}]`).length === 1);
}

function combos(skins) {
  for (const visitor of VISITORS) {
    for (const pin of PINS) {
      const built = pin && skins.includes(pin);
      const expected = built ? pin : skins.includes(visitor) ? visitor : css.DEFAULT_SKIN;
      it(`data-os=${visitor} pin=${pin} -> ${expected} of [${skins}]`, function () {
        const html = pane.folder(TREE, { files: FILES, os: pin }).html;
        const m = matching(visitor, html, skins);
        expect(m).toEqual([expected]);
        expect(visibleCells(html, expected)).toBe(true);
      });
    }
  }
}

describe("pane skins and the default fallback", function () {
  describe("with the skins built today", function () {
    combos(css.SKINS.slice());
  });

  describe("when a skin is added", function () {
    let saved;
    beforeEach(function () {
      saved = css.SKINS.slice();
      css.SKINS.push("win");
    });
    afterEach(function () {
      css.SKINS.splice(0, css.SKINS.length, ...saved);
    });

    it("stops falling back for that OS, and honours its pin", function () {
      const skins = css.SKINS.slice();
      expect(skins).toEqual(["mac", "win"]);
      const html = pane.folder(TREE, { os: "win" }).html;
      expect(html).toContain('data-pin="win"');
      expect(matching("win", pane.folder(TREE).html, skins)).toEqual(["win"]);
      expect(matching("linux", pane.folder(TREE).html, skins)).toEqual(["mac"]); // still unbuilt
      expect(matching(undefined, pane.folder(TREE).html, skins)).toEqual(["mac"]);
    });

    it("builds the prose rule the same way", function () {
      const out = css.unbuilt(css.SKINS);
      expect(out).toBe("html:not(:is([data-os=mac],[data-os=win]))");
    });
  });

  // the group matches by cheerio above; the built sheet has to use it too
  describe("the built sheet", function () {
    it("never matches a data-os of an unbuilt OS with a real skin's rule", function () {
      const { css: out } = pane.assets();
      expect(out).not.toContain("html:not([data-os])");
      expect(out).toContain("html:not(:is([data-os=mac])) .pane:not([data-pin])");
    });
  });

  describe("a pin for an OS with no skin", function () {
    it("is ignored: no data-pin, follows the visitor", function () {
      const html = pane.folder(TREE, { os: "win" }).html;
      expect(html).not.toContain("data-pin");
      expect(html).toContain('data-os="win"');
    });

    it("does not throw for odd input", function () {
      for (const os of [null, "", "BSD", "__proto__", 5, {}, ["win"]]) {
        expect(() => pane.folder(TREE, { os })).not.toThrow();
      }
      expect(() => pane.folder("", {})).not.toThrow();
      expect(() => pane.folder("a.\n.b\n..\n.txt\nx.TXT | | ", { title: '"><b>' })).not.toThrow();
    });
  });
});

describe("pane Type cell and extension hiding", function () {
  it("words the Type per OS", function () {
    expect(formatType("Fruits", true, "win")).toBe("File folder");
    expect(formatType("About.txt", false, "win")).toBe("Text Document");
    expect(formatType("Animation.gif", false, "win")).toBe("GIF File");
    expect(formatType("Logo.JPG", false, "win")).toBe("JPG File");
    expect(formatType("Draft.md", false, "win")).toBe("MD File");
    expect(formatType("index.html", false, "win")).toBe("Microsoft Edge HTML Document");
    expect(formatType("data.xyz", false, "win")).toBe("XYZ File");
    expect(formatType("LICENSE", false, "win")).toBe("File");
    expect(formatType("constructor", false, "win")).toBe("File");
    expect(formatType("Fruits", true, "linux")).toBe("Folder");
    expect(formatType("About.txt", false, "linux")).toBe("Text");
    expect(formatType("a.gif", false, "linux")).toBe("Image");
    expect(formatType("a.xyz", false, "linux")).toBe("Unknown");
    expect(formatType("a.txt", false, "mac")).toBe("");
  });

  it("emits a Type cell with win and linux children only, and none for a window pinned to macOS", function () {
    const $ = cheerio.load(pane.folder("Fruits\n  a.gif").html);
    expect($(".pane-t").length).toBe(2);
    expect($(".pane-t").first().children().toArray().map((c) => c.attribs["data-os"])).toEqual(["win", "linux"]);
    expect($(".pane-t").first().text()).toBe("File folderFolder");
    expect(pane.folder("a.gif", { os: "mac" }).html).not.toContain("pane-cell pane-t");
  });

  it("hides the extension only where Explorer does", function () {
    expect(splitExtension("About.txt")).toEqual(["About", ".txt"]);
    expect(splitExtension("a.b.txt")).toEqual(["a.b", ".txt"]);
    expect(splitExtension("Draft.md")).toBeNull();
    expect(splitExtension("Blot.webloc")).toBeNull();
    expect(splitExtension(".txt")).toBeNull();
    expect(splitExtension("Fruits")).toBeNull();
    const html = pane.folder("About.txt\nDraft.md").html;
    expect(html).toContain('About<span class="pane-x">.txt</span>');
    expect(html).toContain("Draft.md</span>");
  });

  it("keeps one string per pinned window", function () {
    // win is not built yet: the pin is ignored, so this is the unpinned form
    const $ = cheerio.load(pane.folder("About.txt", { os: "mac" }).html);
    expect($(".pane-label").text()).toBe("About.txt");
    expect($(".pane-x").length).toBe(0);
  });

  it("drops a hidden extension from a window pinned to Windows once that skin is built", function () {
    css.SKINS.push("win");
    try {
      const $ = cheerio.load(pane.folder("About.txt\nDraft.md", { os: "win" }).html);
      expect($(".pane-label").toArray().map((l) => $(l).text())).toEqual(["About", "Draft.md"]);
      expect($(".pane-x").length).toBe(0);
      expect($(".pane-t [data-os]").length).toBe(2);
      expect($(".pane-t").first().text()).toBe("Text Document");
    } finally {
      css.SKINS.pop();
    }
  });

  it("gives every OS its own folder size", function () {
    const $ = cheerio.load(pane.folder("Fruits\n  a.md\n  b.md\nEmpty/").html);
    const sizes = $(".pane-s").toArray().filter((_, i) => i === 0 || i === 3);
    expect($(sizes[0]).children("[data-os=mac]").text()).toBe("--");
    expect($(sizes[0]).children("[data-os=win]").text()).toBe("");
    expect($(sizes[0]).children("[data-os=linux]").text()).toBe("2 items");
    expect($(sizes[1]).children("[data-os=linux]").text()).toBe("0 items");
  });

  it("costs nothing on macOS: the Type cell is hidden by base.css, the extension span is not", function () {
    const { css: out } = pane.assets();
    expect(out).toContain(".pane-t{display:none}");
    expect(out).not.toContain(".pane-x{display:none}");
  });
});
