// The icons view (DESIGN.md, "Icons view"): markup contract, the fallback for skins that lack it,
// and (in Chrome) the grid, the two-line labels and the 64px icons of the macOS skin.
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const css = require("../lib/css");
const pane = require("../index");

const TREE = "Fruits\n  Apple.md\nAbout.txt\nBlot.webloc\nNotes.org\nLogo.png";

describe("pane icons view markup", function () {
  const $ = cheerio.load(pane.folder(TREE, { view: "icons", title: "Site" }).html);

  it("is a figure with the same fixed chrome and a flat, real list of the top-level items", function () {
    expect($("figure.pane").attr("data-view")).toBe("icons");
    expect($("figure.pane > *").length).toBe(3); // bar, head, list
    expect($(".pane-head i").length).toBe(3);
    expect($("ul").length).toBe(1);
    expect($("ul").attr("role")).toBe("list");
    expect($("ul > li").length).toBe(5);
    expect($("li ul").length).toBe(0); // no nested rows: a folder can't expand in place
    expect($("li:contains(Apple)").length).toBe(0);
  });

  it("gives every item an icon and a label, with no row or cells", function () {
    $("li").each((i, li) => {
      expect($(li).children().length).toBe(2);
      expect($(li).children("i.pane-icon").length).toBe(1);
      expect($(li).children("span.pane-label").length).toBe(1);
    });
    expect($(".pane-row, .pane-cell, [data-os]").length).toBe(0);
  });

  it("says 'folder' for screen readers, without saying 'expanded'", function () {
    expect($("li").first().find(".pane-sr").text()).toBe(", folder");
    expect($(".pane-tree").text()).not.toContain("expanded");
  });

  it("carries the extension of a generic file for the icon's caption", function () {
    expect($("li:contains(Notes) i").attr("data-ext")).toBe("ORG");
    expect($("li:contains(About) i").attr("data-ext")).toBeUndefined();
  });

  it("keeps the label one string, wrapping the hidden extension for Windows as the list view does", function () {
    expect($("li:contains(About) .pane-label").text()).toBe("About.txt");
    expect($("li:contains(About) .pane-x").text()).toBe(".txt");
  });

  it("is a named, keyboard-reachable scroller only when it can scroll", function () {
    const few = (o) => pane.folder("a.md\nb.md", { view: "icons", ...o }).html;
    expect(few()).not.toContain("tabindex");
    expect(few({ height: "200px", title: "T" })).toContain('tabindex="0" aria-label="T"');
    expect($(".pane-tree").attr("tabindex")).toBe("0");
    expect($(".pane-tree").attr("aria-label")).toBe("Site");
  });

  it("emits no column-only state (stripes, wider dates) and escapes names", function () {
    const html = pane.folder("<b>.md\nYesterday", { view: "icons" }).html;
    expect(html).not.toMatch(/pane-odd|pane-yd/);
    expect(html).toContain("&lt;b&gt;.md");
  });

  it("treats tree as list and anything unknown as not built", function () {
    expect(pane.SUPPORTED_VIEWS).toContain("icons");
    expect(pane.folder("a.md", { view: "columns" })).toBeNull();
    expect(pane.transform).toBeDefined();
  });

  it("is a view of the docs syntax: data-view on the pre", function () {
    const doc = cheerio.load('<pre class="folder" data-view="icons"><code>a.md\nDir</code></pre>');
    pane.transform(doc);
    expect(doc('figure[data-view="icons"] li').length).toBe(2);
  });
});

describe("pane icons view skins", function () {
  it("is built for macOS only for now, so other skins fall back to it", function () {
    expect(css.viewsOf("mac")).toEqual(["list", "icons"]);
    expect(css.viewsOf("win")).toEqual(["list"]);
    expect(css.viewsOf("linux")).toEqual(["list"]);
    const mac = css.group("mac");
    expect(mac).toContain("html[data-os=win] .pane[data-view=icons]:not([data-pin])");
    expect(mac).toContain("html[data-os=linux] .pane[data-view=icons]:not([data-pin])");
    expect(css.group("win")).toContain(":not([data-view=icons])");
    expect(css.group("mac")).not.toMatch(/\.pane:not\(\[data-pin\]\):not\(\[data-view/);
  });

  it("drops an os pin for a skin without the view, and warns", function () {
    spyOn(console, "warn");
    const html = pane.folder("a.md", { view: "icons", os: "win" }).html;
    expect(html).not.toContain("data-pin");
    expect(console.warn).toHaveBeenCalled();
    expect(pane.folder("a.md", { view: "icons", os: "mac" }).html).toContain('data-pin="mac"');
    expect(pane.folder("a.md", { os: "win" }).html).toContain('data-pin="win"'); // the list view is unaffected
  });

  it("draws every kind at 64px from big SVGs, and no bitmaps", function () {
    const source = fs.readFileSync(path.join(__dirname, "..", "css", "mac-icons.css"), "utf8");
    for (const kind of ["folder", "text", "md", "doc", "html", "generic", "link", "image"]) expect(source).toContain(`.pane-k-${kind}{background-image:url(icon:mac/big-`);
    expect(source).not.toMatch(/\.png|\.jpg|image\/png/);
    expect(pane.assets().css).not.toContain("icon:mac");
  });

  it("joins the tokens of the skin's files instead of gluing them together", function () {
    const out = pane.assets().css;
    // mac.css, mac-editor.css, mac-icons.css, in name order: each block's last token is followed by the next block's first
    expect(out).toContain("--pill-sh:rgba(0,0,0,.13);--ed-fg:");
    expect(out).toContain("--tok-v:currentColor;--ish:");
    expect(out).not.toContain(";;");
  });
});

let chrome = true;
try {
  require("puppeteer");
} catch (e) {
  chrome = false;
}

(chrome ? describe : xdescribe)("pane icons view in Chrome (macOS skin)", function () {
  let browser;
  let page;
  const timeout = 120000;
  const NAMES = "About.txt\nAnimation.gif\nBlot.webloc\nDraft.md\nLogo.png\nNotes.md\nOld report.doc\nPhoto.jpg\nTasks.org\nFruits";

  beforeAll(async () => {
    browser = await require("../qa/lib/render").launch();
    page = await browser.newPage();
  }, timeout);
  afterAll(async () => browser && (await browser.close()));

  const show = async (tree, { width = 490, os = "mac", options = {}, theme = "light" } = {}) => {
    await page.setViewport({ width: 700, height: 700 });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
    const html = pane.folder(tree, { view: "icons", ...options }).html.replace('class="pane"', `class="pane" style="--pane-w:${width}px"`);
    await page.setContent(`<!doctype html><html data-os="${os}"><head><style>${pane.assets().css}</style></head><body style="margin:0">${html}</body></html>`);
  };
  const boxes = () =>
    page.evaluate(() => {
      const r = (el) => {
        const b = el.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      };
      return { win: r(document.querySelector(".pane")), lis: [...document.querySelectorAll(".pane-tree > li")].map(r), icons: [...document.querySelectorAll(".pane-icon")].map(r), labels: [...document.querySelectorAll(".pane-label")].map(r) };
    });

  it("lays 112px cells out in as many columns as fit, from the window's left padding", async function () {
    await show(NAMES);
    const b = await boxes();
    const cols = (b2) => new Set(b2.lis.map((l) => Math.round(l.x))).size;
    expect(cols(b)).toBe(4);
    expect(b.lis[0].w).toBe(112);
    expect(b.lis[0].h).toBe(112);
    expect(b.lis[0].x - b.win.x).toBe(10);
    expect(b.lis[4].y - b.lis[0].y).toBe(112);
    await show(NAMES, { width: 300 });
    expect(cols(await boxes())).toBe(2);
    await show(NAMES, { width: 240 });
    expect(cols(await boxes())).toBe(2);
    await show(NAMES, { width: 560 });
    expect(cols(await boxes())).toBe(4);
    await show(NAMES, { width: 600 });
    expect(cols(await boxes())).toBe(5);
  }, timeout);

  it("puts a 64px icon over a centred label, 52px below the window top at most 14px in", async function () {
    await show(NAMES);
    const b = await boxes();
    expect(b.icons[0].w).toBe(64);
    expect(b.icons[0].h).toBe(64);
    expect(b.icons[0].y - b.win.y).toBe(66);
    expect(Math.abs(b.icons[0].x + 32 - (b.lis[0].x + 56))).toBeLessThan(0.5);
    expect(b.labels[0].y).toBeGreaterThan(b.icons[0].y + 64);
  }, timeout);

  it("hides the column header and shows no list-view state", async function () {
    await show(NAMES);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".pane-head")).display)).toBe("none");
  }, timeout);

  it("wraps a label to two lines and cuts the rest, breaking a word that has no spaces", async function () {
    await show("one two three four five six seven eight nine ten eleven twelve thirteen fourteen.md\nunbrokenunbrokenunbrokenunbrokenunbrokenunbrokenunbroken.txt\nShort.md");
    const b = await boxes();
    expect(b.labels[0].h).toBe(32);
    expect(b.labels[1].h).toBe(32);
    expect(b.labels[2].h).toBe(32); // a fixed two-line box: cells stay aligned
    const clipped = await page.evaluate(() => [...document.querySelectorAll(".pane-label")].map((l) => l.scrollHeight > l.clientHeight));
    expect(clipped.slice(0, 2)).toEqual([true, true]);
    expect(clipped[2]).toBe(false);
    const ellipsis = await page.evaluate(() => getComputedStyle(document.querySelector(".pane-label")).webkitLineClamp);
    expect(ellipsis).toBe("2");
  }, timeout);

  it("draws the generic caption from the extension and 'HTTP' for a link", async function () {
    await show("Notes.org\nBlot.webloc\nPlain");
    const caption = () => page.evaluate(() => [...document.querySelectorAll(".pane-icon")].map((i) => getComputedStyle(i, "::after").content));
    expect(await caption()).toEqual(['"ORG"', '"HTTP"', "none"]);
  }, timeout);

  it("draws the folder, a doc and the image icon differently, and the same in dark", async function () {
    for (const theme of ["light", "dark"]) {
      await show(NAMES, { theme });
      const images = await page.evaluate(() => [...document.querySelectorAll(".pane-icon")].map((i) => getComputedStyle(i).backgroundImage.length));
      expect(new Set(images).size).toBeGreaterThan(5);
      expect(images.every((n) => n > 100)).toBe(true);
      const shadow = await page.evaluate(() => getComputedStyle(document.querySelector(".pane-icon")).filter);
      expect(theme === "light" ? shadow : "none").toBe(shadow);
    }
  }, timeout);

  it("is the same window on Windows and Linux until their skins land (default-skin fallback)", async function () {
    await show(NAMES);
    const mac = await boxes();
    for (const os of ["win", "linux"]) {
      await show(NAMES, { os });
      const other = await boxes();
      expect(other.win).toEqual(mac.win);
      expect(other.lis).toEqual(mac.lis);
    }
    // and the list view keeps its own skin there
    await page.setContent(`<html data-os="win"><style>${pane.assets().css}</style>${pane.folder("a.md").html}`);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".pane-head")).display)).not.toBe("none");
  }, timeout);

  it("keeps the window fitting its items, capped at 360px", async function () {
    await show("a.md\nb.md");
    expect((await boxes()).win.h).toBe(52 + 14 + 112 + 8);
    await show(Array.from({ length: 40 }, (_, i) => `f${i}.md`).join("\n"));
    expect((await boxes()).win.h).toBe(360);
  }, timeout);
});
