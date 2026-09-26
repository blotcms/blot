// Accessibility and mobile audit (qa/lib/audit.js) as a test: every skin, both themes, real
// Chrome. Also proves the audit's checks fire on the defects they exist for. Needs Chrome.
let chrome = true;
try {
  require("puppeteer");
} catch (e) {
  chrome = false;
}

(chrome ? describe : xdescribe)("pane accessibility and mobile audit", function () {
  const { launch } = require("../qa/lib/render");
  const { audit, inspect } = require("../qa/lib/audit");
  let browser;
  const timeout = 120000;

  beforeAll(async () => {
    browser = await launch(true);
  }, timeout);
  afterAll(async () => browser && (await browser.close()));

  ["mac", "win", "linux"].forEach((skin) => {
    it(`${skin}: no findings (structure, focus, forced colours, motion, narrow widths)`, async function () {
      const findings = await audit(browser, { skins: [skin] });
      expect(findings.map((f) => `${f.skin} ${f.theme}/${f.sample}@${f.width} ${f.rule}: ${f.message}`)).toEqual([]);
    }, timeout);
  });

  describe("catches", function () {
    const rules = async (body, css = "") => {
      const page = await browser.newPage();
      try {
        await page.setContent(`<style>${css}</style><body>${body}</body>`);
        return (await page.evaluate(inspect)).map((f) => f.rule);
      } finally {
        await page.close();
      }
    };
    const ok = '<figure class="pane" aria-label="x"><div class="pane-bar" aria-hidden="true"></div><div class="pane-head" aria-hidden="true"></div><ul class="pane-tree" role="list"><li><span class="pane-row"><span class="pane-label"><i class="pane-icon"></i>a.md</span></span></li></ul></figure>';

    it("nothing in a clean window", async function () {
      expect(await rules(ok)).toEqual([]);
    }, timeout);

    it("a window with no name, chrome that is not hidden, and role=tree", async function () {
      expect(await rules(ok.replace(' aria-label="x"', ""))).toContain("name");
      expect(await rules(ok.replace('class="pane-bar" aria-hidden="true"', 'class="pane-bar"'))).toContain("chrome");
      expect(await rules(ok.replace('role="list"', 'role="tree"'))).toContain("tree");
    }, timeout);

    it("a list without role=list, and a folder row without the hidden 'folder' text", async function () {
      expect(await rules(ok.replace(' role="list"', ""))).toContain("list");
      expect(await rules(ok.replace('<i class="pane-icon"></i>', '<i class="pane-icon pane-k-folder"></i>'))).toContain("label");
    }, timeout);

    it("a scrollable region that keyboards cannot reach or that has no name", async function () {
      const css = ".pane-tree{overflow:auto;height:20px}.pane-row{display:block;height:100px}";
      expect(await rules(ok, css)).toContain("scroller");
      expect(await rules(ok.replace('role="list"', 'role="list" tabindex="0"'), css)).toContain("scroller"); // focusable but nameless
      expect(await rules(ok.replace('role="list"', 'role="list" tabindex="0" aria-label="x"'), css)).toEqual([]);
    }, timeout);

    it("an icons window with a nested list, an item without label or icon, or a folder without 'folder'", async function () {
      const icons = '<figure class="pane" data-view="icons" aria-label="x"><div class="pane-bar" aria-hidden="true"></div><div class="pane-head" aria-hidden="true"></div><ul class="pane-tree" role="list"><li><i class="pane-icon"></i><span class="pane-label">a.md</span></li></ul></figure>';
      expect(await rules(icons)).toEqual([]);
      expect(await rules(icons.replace("</li>", '<ul role="list"><li>b</li></ul></li>'))).toContain("icons");
      expect(await rules(icons.replace(">a.md<", "><"))).toContain("label");
      expect(await rules(icons.replace('<i class="pane-icon"></i>', ""))).toContain("icons");
      expect(await rules(icons.replace('class="pane-icon"', 'class="pane-icon pane-k-folder"'))).toContain("label");
    }, timeout);

    it("a cell showing two OS variants, and a focusable element inside aria-hidden", async function () {
      const cell = '<span class="pane-cell"><span data-os="mac">1</span><span data-os="win">2</span></span>';
      expect(await rules(ok.replace("</span></span></li>", `</span>${cell}</span></li>`))).toContain("cell");
      expect(await rules(ok.replace('class="pane-head" aria-hidden="true"', 'class="pane-head" aria-hidden="true" tabindex="0"'))).toContain("hidden");
    }, timeout);
  });
});
