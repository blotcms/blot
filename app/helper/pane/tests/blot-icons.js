// The Blot study features (DESIGN.md, "Icons view"): selection, thumbnails, a name cut in the middle,
// large icons, the view-mode button, and reflow with the window width.

const pane = require("../index");
const parse = require("../lib/parse");

const GIF =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=";
const LONG = "fly-with-even-longer-name-that-gets-truncated.jpg";

describe("pane attributes", function () {
  it("reads [flag] and [key=value] fields after a pipe and keeps them out of the columns", function () {
    const [a, b] = parse(
      `Blot | [selected]\nToucan.jpg | 2 KB | [img=/a/b.jpg] | Mar 3`
    );
    expect(a.attrs).toEqual({ selected: true });
    expect(a.cols).toEqual([]);
    expect(b.attrs).toEqual({ img: "/a/b.jpg" });
    expect(b.cols).toEqual(["2 KB", "Mar 3"]);
  });
});

describe("pane selection", function () {
  it("marks an icon, a row, and tells screen readers", function () {
    const icons = pane.folder("Blot | [selected]\nAbout.txt", {
      view: "icons",
    }).html;
    expect(icons).toContain('<li class="pane-sel">');
    expect(icons).toContain(', folder</span><span class="pane-sr">, selected');
    expect(icons.match(/pane-sel/g).length).toBe(1);
    const list = pane.folder("Blot | [selected]\nAbout.txt").html;
    expect(list).toMatch(/class="pane-row pane-sel"/);
    expect(list.match(/, selected/g).length).toBe(1);
  });
});

describe("pane thumbnails", function () {
  it("puts the picture in the icon, and drops addresses that are not pictures", function () {
    const html = pane.folder(
      `A.jpg | [img=${GIF}]\nB.jpg | [img=javascript:alert(1)]\nC.jpg | [img=https://x.test/c.jpg]\nD.jpg | [img=/d.jpg]\nE.jpg`,
      { view: "icons" }
    ).html;
    expect(html.match(/<img /g).length).toBe(3);
    expect(html).not.toContain("javascript:");
    expect(html).toContain('<i class="pane-icon pane-k-image pane-th">');
    expect(html).toContain('alt=""');
  });

  it("escapes the address", function () {
    const html = pane.folder('A.jpg | [img=/a"><script>.jpg]', {
      view: "icons",
    }).html;
    expect(html).not.toContain("<script>");
  });
});

describe("pane long names", function () {
  it("splits a name that cannot fit two lines and keeps the whole name in the text", function () {
    const html = pane.folder(
      `${LONG}\nShort.md\nweaver-long-name-finishes.jpg`,
      {
        view: "icons",
      }
    ).html;
    expect(html).toMatch(
      /<span class="pane-m" style="--n:9">fly-with-even-longer-name-that-gets-trun<\/span><span class="pane-e">cated\.jpg<\/span>/
    );
    expect(html.match(/pane-m/g).length).toBe(1); // only the long one
  });
});

describe("pane large icons and the toolbar button", function () {
  it("classes the window", function () {
    expect(
      pane.folder("a.md", { view: "icons", iconSize: "large" }).html
    ).toContain("pane pane-lg");
    expect(
      pane.folder("a.md", { view: "icons", toolbar: "view" }).html
    ).toContain("pane pane-vb");
    expect(
      pane.folder("a.md", { iconSize: "large", toolbar: "view" }).html
    ).not.toMatch(/pane-lg|pane-vb/);
  });

  it("the docs transform reads data-icon-size and data-toolbar", function () {
    const cheerio = require("cheerio");
    const $ = cheerio.load(
      '<pre class="folder" data-view="icons" data-icon-size="large" data-toolbar="view">Blot | [selected]</pre>'
    );
    pane.transform($);
    expect($("figure").hasClass("pane-lg")).toBe(true);
    expect($("figure").hasClass("pane-vb")).toBe(true);
    expect($("li.pane-sel").length).toBe(1);
  });
});

describe("pane icons in Chrome", function () {
  let browser;
  beforeAll(async function () {
    browser = await require("../qa/lib/render").launch();
  });
  afterAll(async function () {
    if (browser) await browser.close();
  });

  const measure = async (html, width, fn) => {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 800, height: 700 });
      await page.emulateMediaFeatures([
        { name: "prefers-color-scheme", value: "light" },
      ]);
      await page.setContent(
        `<style>body{margin:0}${pane.assets().css}</style><script>${pane.assets().js}</script>${html}`
      );
      await page.evaluate(() => document.fonts.ready);
      return await page.evaluate(fn);
    } finally {
      await page.close();
    }
  };

  it("reflows the icons to the window width", async function () {
    const tree = "a.md\nb.md\nc.md\nd.md\ne.md\nf.md";
    const columns = (w) =>
      measure(
        pane.folder(tree, { view: "icons", width: w, height: "400px" }).html,
        w,
        () =>
          new Set(
            [...document.querySelectorAll(".pane-tree > li")].map((li) =>
              Math.round(li.getBoundingClientRect().left)
            )
          ).size
      );
    expect(await columns("567px")).toBe(4);
    expect(await columns("440px")).toBe(3);
    expect(await columns("700px")).toBe(6);
  });

  it("selects with a grey backing behind the icon and a pill that hugs the name", async function () {
    const r = await measure(
      pane.folder("Blot | [selected]\nAbout.txt", { view: "icons" }).html,
      490,
      () => {
        const li = document.querySelector("li.pane-sel");
        const back = getComputedStyle(li, "::before");
        const label = li.querySelector(".pane-label");
        return {
          back: [back.width, back.height, back.backgroundColor],
          pill: getComputedStyle(label).backgroundColor,
          pillW: label.getBoundingClientRect().width,
        };
      }
    );
    expect(r.back[0]).toBe("72px");
    expect(r.back[1]).toBe("72px");
    expect(r.back[2]).toBe("rgb(230, 230, 230)");
    expect(r.pill).toBe("rgb(0, 100, 225)");
    expect(r.pillW).toBeLessThan(60);
  });

  it("draws a thumbnail in proportion inside the icon box, large icons at twice the size", async function () {
    const run = (iconSize) =>
      measure(
        pane.folder(`T.jpg | [img=${GIF}]`, { view: "icons", iconSize }).html,
        490,
        () => {
          const icon = document
            .querySelector(".pane-icon")
            .getBoundingClientRect();
          const img = document
            .querySelector(".pane-icon img")
            .getBoundingClientRect();
          return {
            icon: icon.width,
            img: img.width,
            inside: img.width <= icon.width,
          };
        }
      );
    const small = await run();
    const large = await run("large");
    expect(small.icon).toBe(64);
    expect(large.icon).toBe(128);
    expect(small.inside && large.inside).toBe(true);
  });

  it("keeps the end of a long name on the second line, and never lets it overflow its cell", async function () {
    const r = await measure(
      pane.folder(`${LONG}\nShort.md`, { view: "icons" }).html,
      490,
      () => {
        const label = document
          .querySelector(".pane-label")
          .getBoundingClientRect();
        const m = document.querySelector(".pane-m").getBoundingClientRect();
        const e = document.querySelector(".pane-e").getBoundingClientRect();
        return {
          labelH: label.height,
          mH: m.height,
          eInside:
            e.right <= label.right + 0.5 && e.bottom <= label.bottom + 0.5,
          eOnLine2: e.top >= label.top + 15,
          text: document.querySelector("li .pane-label").textContent,
        };
      }
    );
    expect(r.labelH).toBe(32);
    expect(r.mH).toBeLessThanOrEqual(32);
    expect(r.eInside).toBe(true);
    expect(r.eOnLine2).toBe(true);
    expect(r.text).toBe(LONG);
  });

  it("shows the view-mode button only on request", async function () {
    const shown = (opts) =>
      measure(pane.folder("a.md", { view: "icons", ...opts }).html, 490, () => {
        const head = document.querySelector(".pane-head");
        return getComputedStyle(head).display;
      });
    expect(await shown({})).toBe("none");
    expect(await shown({ toolbar: "view" })).toBe("block");
  });
});

describe("pane QA adapter, Blot study views", function () {
  const adapter = require("../qa/pane-adapter");
  const c = (view) => ({
    os: "macos",
    view,
    windowSize: { width: 567, height: 410 },
  });

  it("renders each study view as the study's window", async function () {
    for (const view of ["hero", "iconssel", "large", "largesel"]) {
      const { html } = await adapter.render(`macos-light-${view}`, c(view));
      expect(html).toContain("pane-vb");
      expect(html.match(/<img /g).length).toBe(3);
      expect(html).toContain('aria-label="Blot"');
      expect(html.includes("pane-lg")).toBe(view.startsWith("large"));
    }
    const sel = await adapter.render("x", c("iconssel"));
    expect(sel.html.match(/pane-sel/g).length).toBe(2);
    const list = await adapter.render("x", c("listsel"));
    expect(list.html).toMatch(/pane-row pane-open pane-sel/);
    expect(await adapter.render("x", { ...c("hero"), os: "linux" })).toBe(null);
  });
});
