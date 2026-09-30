// The editor windows in real Chrome: what is selected and copied, wrapping, and the skin's
// geometry. Nothing here compares antialiased pixels; measurements are of layout, with slack.
let chrome = true;
try {
  require("puppeteer");
} catch (e) {
  chrome = false;
}

(chrome ? describe : xdescribe)("pane editor windows in Chrome", function () {
  const { launch } = require("../qa/lib/render");
  const pane = require("../index");
  let browser;
  let page;
  const timeout = 60000;

  const PROSE = "The first frost came late this year, and the garden held on to its colour well into November. I spent most of the weekend clearing the beds.\n\n  Indented, with   spaces,\ttabs & <b>markup</b>.";
  const CODE = '<!doctype html>\n<html lang="en">\n\n  <p class="intro">A page made from a plain text file, with a line long enough to scroll sideways.</p>\n</html>';

  const show = async (html, { os = "mac", width = 800, extra = "" } = {}) => {
    await page.setViewport({ width, height: 700 });
    await page.setContent(`<!doctype html><html data-os="${os}"><head><style>${pane.assets().css}${extra}</style></head><body style="margin:0">${html}</body></html>`);
  };
  const selected = () =>
    page.evaluate(() => {
      const r = document.createRange();
      r.selectNodeContents(document.querySelector(".pane-body"));
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return s.toString();
    });

  beforeAll(async () => {
    browser = await launch(true);
    page = await browser.newPage();
  }, timeout);
  afterAll(async () => browser && (await browser.close()));

  it("copies exactly the source: no line numbers, token text or chrome, even with the gutter switched on", async function () {
    await show(pane.text(PROSE, { title: "Post.txt" }).html);
    expect(await selected()).toBe(PROSE);
    // a skin that shows the gutter: the numbers are generated content, not text
    await show(pane.code(CODE, { title: "a.html" }).html, { extra: ".pane .pane-l::before{display:inline-block}" });
    expect(await selected()).toBe(CODE);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".pane-l"), "::before").userSelect)).toBe("none");
  }, timeout);

  it("wraps prose and does not wrap code (which scrolls, and is reachable)", async function () {
    await show(pane.text(PROSE.repeat(1)).html, { width: 380 });
    expect(await page.evaluate(() => { const b = document.querySelector(".pane-body"); return b.scrollWidth - b.clientWidth; })).toBeLessThanOrEqual(1);
    await show(pane.code(CODE).html, { width: 380 });
    const info = await page.evaluate(() => { const b = document.querySelector(".pane-body"); return { over: b.scrollWidth - b.clientWidth, tab: b.getAttribute("tabindex"), ws: getComputedStyle(b).whiteSpace }; });
    expect(info.over).toBeGreaterThan(20);
    expect(info.tab).toBe("0");
    expect(info.ws).toBe("pre");
  }, timeout);

  it("shows the gutter a skin turns on, one number per line, pinned while the code scrolls sideways", async function () {
    const html = pane.code(CODE, { title: "a.html", width: "300px" }).html;
    await show(html, { extra: ".pane .pane-l::before{display:inline-block;width:3ch}" });
    const numbers = await page.evaluate(() => [...document.querySelectorAll(".pane-l")].map((l) => getComputedStyle(l, "::before").content));
    expect(numbers.length).toBe(CODE.split("\n").length);
    // the number sits at the body's left edge before and after scrolling: the first line's number box
    // is measured through the line's own left edge when unscrolled, and stays put when scrolled
    const box = () => page.evaluate(() => { const b = document.querySelector(".pane-body"); const r = document.createRange(); const l = b.querySelector(".pane-l"); r.selectNodeContents(l); return { text: r.getBoundingClientRect().left, body: b.getBoundingClientRect().left, scroll: b.scrollLeft }; });
    const before = await box();
    await page.evaluate(() => { document.querySelector(".pane-body").scrollLeft = 60; });
    const after = await box();
    expect(after.scroll).toBeGreaterThan(before.scroll);
    expect(before.text - after.text).toBeGreaterThan(40); // the text moved left ...
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".pane-l"), "::before").position)).toBe("sticky"); // ... the numbers do not
  }, timeout);

  it("macOS: a 32px title bar with a hairline, traffic lights, the proxy icon and a chevron; no bar when bare", async function () {
    await show(pane.text("x", { title: "Essay.txt", width: "490px" }).html);
    const m = await page.evaluate(() => {
      const w = document.querySelector(".pane");
      const bar = document.querySelector(".pane-bar");
      const cs = (e, p) => getComputedStyle(e, p);
      return { win: w.getBoundingClientRect().width, bar: bar.getBoundingClientRect().height, line: cs(bar).borderBottomWidth, radius: cs(w).borderTopLeftRadius, lights: cs(w, "::before").height, icon: cs(bar, "::before").width, chevron: cs(bar, "::after").display, head: cs(document.querySelector(".pane-head")).display };
    });
    expect(m).toEqual({ win: 490, bar: 32, line: "1px", radius: "16px", lights: "32px", icon: "14px", chevron: "inline-block", head: "none" });
    await show(pane.text("x", { chrome: false }).html);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".pane"), "::before").display)).toBe("none");
    // a code window without a title shows neither the icon nor the chevron
    await show(pane.code("x").html);
    expect(await page.evaluate(() => [getComputedStyle(document.querySelector(".pane-bar"), "::before").display, getComputedStyle(document.querySelector(".pane-bar"), "::after").display])).toEqual(["none", "none"]);
  }, timeout);

  it("macOS: TextEdit does not colour syntax (the token colours are the text colour), and a skin can switch them on", async function () {
    await show(pane.code('<a href="x">y</a>').html);
    const colours = () => page.evaluate(() => [...document.querySelectorAll("[class^=pane-t-]")].map((e) => getComputedStyle(e).color));
    const plain = await colours();
    expect(plain.length).toBeGreaterThan(2);
    expect(new Set(plain).size).toBe(1);
    await show(pane.code('<a href="x">y</a>').html, { extra: ".pane{--tok-s:rgb(200,0,0)!important}" });
    expect(new Set(await colours()).size).toBeGreaterThan(1);
  }, timeout);

  it("follows the theme: white on black in dark, black on white in light", async function () {
    const html = pane.text("x", { title: "a.txt" }).html;
    for (const [theme, fg, bg] of [["light", "rgb(0, 0, 0)", "rgb(255, 255, 255)"], ["dark", "rgb(255, 255, 255)", "rgb(30, 30, 30)"]]) {
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
      await show(html);
      expect(await page.evaluate(() => [getComputedStyle(document.querySelector(".pane-body")).color, getComputedStyle(document.querySelector(".pane")).backgroundColor])).toEqual([fg, bg]);
    }
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  }, timeout);

  it("the default height fits the text, capped at the reference height", async function () {
    await show(pane.text("one line").html);
    const short = await page.evaluate(() => document.querySelector(".pane").getBoundingClientRect().height);
    expect(short).toBeLessThan(80);
    await show(pane.text(Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n")).html);
    expect(await page.evaluate(() => document.querySelector(".pane").getBoundingClientRect().height)).toBe(360);
    await show(pane.text("x", { height: "200px" }).html);
    expect(await page.evaluate(() => document.querySelector(".pane").getBoundingClientRect().height)).toBe(200);
  }, timeout);
});
