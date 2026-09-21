// Backdrop independence (qa/lib/matte.js): every window is opaque inside, clear far outside
// and transparent at rounded corners, so it looks right on any desktop. Needs Chrome.
let puppeteer = true;
try {
  require("puppeteer");
  require("sharp");
} catch (e) {
  puppeteer = false;
}

const describeIfChrome = puppeteer ? describe : xdescribe;

describeIfChrome("pane backdrop independence", function () {
  const { loadCases } = require("../qa/lib/cases");
  const { launch } = require("../qa/lib/render");
  const { matte } = require("../qa/lib/matte");
  const adapter = require("../qa/adapter");
  let browser;
  const timeout = 120000;

  beforeAll(async () => {
    browser = await launch();
  }, timeout);
  afterAll(async () => browser && (await browser.close()));

  loadCases()
    .filter((c) => c.view === "default")
    .forEach((c) => {
      it(`${c.id}: opaque inside, clear outside, transparent corners`, async function () {
        const r = await matte(browser, c);
        expect(r).not.toBeNull();
        expect(r.failures).toEqual([]);
      }, timeout);
    });

  // the check must actually catch what it is for
  describe("catches", function () {
    const c = loadCases().find((x) => x.id === "macos-light");
    const fake = (style) => spyOn(adapter, "render").and.returnValue(Promise.resolve({ html: `<div class="pane" style="width:300px;height:200px;${style}"></div>`, css: "" }));

    it("a translucent surface", async function () {
      fake("background:rgba(255,255,255,.5);border-radius:20px");
      expect((await matte(browser, c)).failures.join()).toContain("translucent inside the window");
    }, timeout);

    it("a desktop colour painted around the window", async function () {
      fake("background:#fff;border-radius:20px;box-shadow:0 0 0 400px #808080");
      expect((await matte(browser, c)).failures.join()).toContain("outside the window");
    }, timeout);

    it("a rounded window whose corners are filled in", async function () {
      // the box is rounded, but a square layer paints over the corners
      spyOn(adapter, "render").and.returnValue(
        Promise.resolve({ html: `<div class="pane"><div class="fill"></div></div>`, css: `.pane{position:relative;width:300px;height:200px;background:#fff;border-radius:30px}.fill{position:absolute;top:0;left:0;right:0;bottom:0;background:#fff}` })
      );
      expect((await matte(browser, c)).failures.join()).toContain("corner");
    }, timeout);

    it("accepts square corners", async function () {
      fake("background:#fff;border-radius:0");
      expect((await matte(browser, c)).failures).toEqual([]);
    }, timeout);

    it("accepts a translucent surface that is listed as intended", async function () {
      fake("background:rgba(255,255,255,.5);border-radius:20px");
      const fs = require("fs");
      const file = require("path").join(__dirname, "..", "qa", "backdrop.json");
      const before = fs.readFileSync(file, "utf8");
      try {
        fs.writeFileSync(file, JSON.stringify({ allow: { [c.id]: [{ name: "all", x: 0, y: 0, w: 300, h: 200 }] } }));
        expect((await matte(browser, c)).failures).toEqual([]);
      } finally {
        fs.writeFileSync(file, before);
      }
    }, timeout);
  });
});
