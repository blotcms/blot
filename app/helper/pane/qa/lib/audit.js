// Accessibility and mobile audit of the module's own markup and CSS (not the references):
// renders sample windows in every skin and theme in Chrome and checks what DESIGN.md §5 and §6
// promise: a named window, aria-hidden chrome, real nested lists, one visible OS variant per
// cell, keyboard-reachable named scrollers with a visible focus ring, forced-colors and
// reduced-motion behaviour, and narrow containers (no page overflow; columns drop in order).
// Returns findings: [{ skin, theme, sample, width, rule, message }]. Fonts don't matter.

const pane = require("../../index");

const SKINS = ["mac", "win", "linux"];
const THEMES = ["light", "dark"];
const WIDE = 600;
const NARROW = [500, 440, 390, 375, 360, 320, 280];

const MANY = Array.from({ length: 16 }, (_, i) => `File ${String(i + 1).padStart(2, "0")}.md`).join("\n");
const SAMPLES = {
  small: { tree: "Fruits\n  Apple.md\n  Pear.md\nAbout.txt\nReport.docx\nPhoto.jpg" },
  many: { tree: MANY },
  long: { tree: "A very long file name that goes on and on and on for the width test 2026-09-21 final v2.md\nShort.md" },
  empty: { tree: "" },
  icons: { tree: "Fruits\n  Apple.md\nAbout.txt\nReport.docx\nPhoto.jpg", options: { view: "icons" } },
  iconsMany: { tree: MANY, options: { view: "icons" } },
  iconsLong: { tree: "A very long file name that goes on and on and on for the width test 2026-09-21 final v2.md\nunbrokenunbrokenunbrokenunbrokenunbrokenunbroken.txt\nShort.md", options: { view: "icons" } },
  iconsFixed: { tree: "a.md\nb.md", options: { view: "icons", height: "180px", title: "Fixed" } },
  fixed: { tree: "a.md\nb.md", options: { height: "180px", title: "Fixed" } },
};

// Runs in the page: findings for one window.
function inspect() {
  const out = [];
  const f = (rule, message) => out.push({ rule, message });
  const win = document.querySelector(".pane");
  const name = (el) => `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(" ")[0] : ""}`;

  if (win.tagName !== "FIGURE" || !(win.getAttribute("aria-label") || "").trim()) f("name", "the window has no accessible name (figure + aria-label)");
  for (const el of win.querySelectorAll(".pane-bar, .pane-head")) if (el.getAttribute("aria-hidden") !== "true") f("chrome", `${name(el)} is not aria-hidden`);
  if (win.querySelector("[role=tree], [role=treeitem]")) f("tree", "role=tree/treeitem is used (it promises arrow-key behaviour that isn't there)");
  for (const ul of win.querySelectorAll("ul")) {
    if (ul.getAttribute("role") !== "list") f("list", "a ul without role=list (Safari drops list semantics from list-style:none)");
    if (ul.parentElement !== win && ul.parentElement.tagName !== "LI" && !ul.classList.contains("pane-tree")) f("list", "a nested ul that is not inside an li");
  }
  for (const row of win.querySelectorAll(".pane-row")) {
    const label = row.querySelector(".pane-label");
    if (!label || !label.innerText.trim()) f("label", "a row without label text");
    if (row.querySelector(".pane-k-folder") && !/folder/.test(row.textContent)) f("label", "a folder row without the visually hidden 'folder' text");
  }
  // the icons view: one li per top-level item, each with an icon and a label, and no nested lists
  if (win.dataset.view === "icons") {
    if (win.querySelector("li ul")) f("icons", "the icons view has a nested list (a folder can't expand in place)");
    for (const li of win.querySelectorAll(".pane-tree > li")) {
      const label = li.querySelector(".pane-label");
      if (!label || !label.textContent.trim()) f("label", "an icons item without label text");
      if (!li.querySelector(".pane-icon")) f("icons", "an icons item without an icon");
      if (li.querySelector(".pane-k-folder") && !/folder/.test(li.textContent)) f("label", "a folder item without the visually hidden 'folder' text");
    }
  }
  for (const cell of win.querySelectorAll(".pane-cell")) {
    const shown = [...cell.children].filter((c) => c.hasAttribute("data-os") && getComputedStyle(c).display !== "none");
    if (getComputedStyle(cell).display !== "none" && shown.length > 1) f("cell", `a cell shows ${shown.length} OS variants at once`);
    if (getComputedStyle(cell).display !== "none" && cell.children.length && !shown.length) f("cell", "a displayed cell shows no variant");
  }
  for (const el of win.querySelectorAll("[aria-hidden=true] [tabindex], [aria-hidden=true][tabindex]")) f("hidden", `a focusable element inside aria-hidden: ${name(el)}`);
  for (const el of win.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    const scrolls = (/auto|scroll/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1) || (/auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1);
    if (!scrolls) continue;
    if (el.getAttribute("tabindex") !== "0") f("scroller", `a scrollable region is not keyboard focusable: ${name(el)}`);
    else if (!el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby")) f("scroller", `a focusable scroller has no name: ${name(el)}`);
  }
  return out;
}

// Runs in the page after Tab: the focused scroller must show a focus ring.
function focusRing() {
  const el = document.activeElement;
  if (!el || !el.closest(".pane")) return null;
  const cs = getComputedStyle(el);
  const ring = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
  const shadow = cs.boxShadow !== "none";
  return { focusVisible: el.matches(":focus-visible"), visible: ring || shadow };
}

// Runs in the page: what a container this narrow shows.
function layout() {
  const win = document.querySelector(".pane");
  const shown = (sel) => [...win.querySelectorAll(sel)].some((e) => getComputedStyle(e).display !== "none" && e.getBoundingClientRect().width > 0);
  const tree = win.querySelector(".pane-tree");
  const label = win.querySelector(".pane-label");
  return {
    pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    winWidth: win.getBoundingClientRect().width,
    labelWidth: label ? label.getBoundingClientRect().width : null,
    date: shown(".pane-d"),
    size: shown(".pane-s"),
    type: shown(".pane-t"),
    treeOverflow: tree ? tree.scrollWidth - tree.clientWidth : 0,
    // icons view: a label that sticks out of its grid cell, or an item outside the window
    itemOut: [...win.querySelectorAll('[data-view="icons"] .pane-tree > li')].filter((li) => {
      const r = li.getBoundingClientRect();
      const l = li.querySelector(".pane-label").getBoundingClientRect();
      return l.left < r.left - 0.5 || l.right > r.right + 0.5 || r.right > win.getBoundingClientRect().right + 0.5;
    }).length,
    headShown: shown(".pane-head"),
  };
}

async function audit(browser, { skins = SKINS, themes = THEMES, log = () => {} } = {}) {
  const findings = [];
  const page = await browser.newPage();
  // puppeteer's emulateMediaFeatures lacks forced-colors, so use the protocol directly
  // (Emulation.setEmulatedMedia replaces the whole list, so keep the current state here)
  const client = await page.createCDPSession();
  const media = { "prefers-color-scheme": "light", "prefers-reduced-motion": "no-preference", "forced-colors": "none" };
  const emulate = async (changes) => {
    Object.assign(media, changes);
    await client.send("Emulation.setEmulatedMedia", { features: Object.entries(media).map(([name, value]) => ({ name, value })) });
  };
  const { css: sheet } = pane.assets();
  const page_ = async (skin, theme, sample, width, extra = "") => {
    const s = SAMPLES[sample];
    const html = pane.folder(s.tree, { title: "Docs", ...(s.options || {}) }).html;
    await page.setViewport({ width, height: 800 });
    await emulate({ "prefers-color-scheme": theme });
    await page.setContent(`<!doctype html><html lang="en" data-os="${skin}"><head><meta charset="utf-8"><style>${sheet}${extra}</style></head><body style="margin:0">${html}</body></html>`);
  };
  const add = (skin, theme, sample, width, list) => list.forEach((x) => findings.push({ skin, theme, sample, width, ...x }));
  try {
    for (const skin of skins) {
      for (const theme of themes) {
        // structure and accessibility, at a comfortable width
        for (const sample of Object.keys(SAMPLES)) {
          await page_(skin, theme, sample, WIDE);
          add(skin, theme, sample, WIDE, await page.evaluate(inspect));
        }
        // keyboard: a scroller can be reached with Tab and shows where the focus is
        for (const sample of ["many", "iconsMany"]) {
          await page_(skin, theme, sample, WIDE);
          await page.keyboard.press("Tab");
          const ring = await page.evaluate(focusRing);
          if (!ring) add(skin, theme, sample, WIDE, [{ rule: "focus", message: "Tab does not reach the scrollable list" }]);
          else if (!ring.visible) add(skin, theme, sample, WIDE, [{ rule: "focus", message: "the focused list shows no focus ring" }]);
        }
        // forced colours: the frame is a plain border and nothing casts a shadow
        await page_(skin, theme, "small", WIDE);
        await emulate({ "forced-colors": "active" });
        const forced = await page.evaluate(() => {
          const cs = getComputedStyle(document.querySelector(".pane"));
          return { shadow: cs.boxShadow, border: parseFloat(cs.borderTopWidth) };
        });
        if (forced.shadow !== "none") add(skin, theme, "small", WIDE, [{ rule: "forced-colors", message: "the window keeps its shadow in forced-colors mode" }]);
        if (!(forced.border >= 1)) add(skin, theme, "small", WIDE, [{ rule: "forced-colors", message: "the window has no border in forced-colors mode" }]);
        await emulate({ "forced-colors": "none" });
        // motion: nothing animates, whatever the preference
        for (const motion of ["no-preference", "reduce"]) {
          await emulate({ "prefers-reduced-motion": motion });
          await page_(skin, theme, "small", WIDE);
          const moving = await page.evaluate(() => document.getAnimations().length);
          if (moving) add(skin, theme, "small", WIDE, [{ rule: "motion", message: `${moving} animation(s) running with prefers-reduced-motion: ${motion}` }]);
        }
        await emulate({ "prefers-reduced-motion": "no-preference" });
        // narrow containers: the columns drop in the documented order, and nothing spills out
        for (const sample of ["small", "long", "icons", "iconsLong"]) {
          const seen = [];
          for (const width of [WIDE, ...NARROW]) {
            await page_(skin, theme, sample, width);
            const l = await page.evaluate(layout);
            seen.push({ width, ...l });
            if (l.pageOverflow > 0) add(skin, theme, sample, width, [{ rule: "overflow", message: `the page scrolls sideways by ${l.pageOverflow}px` }]);
            if (l.winWidth > width + 0.5) add(skin, theme, sample, width, [{ rule: "overflow", message: `the window is ${l.winWidth}px wide in a ${width}px page` }]);
            if (l.itemOut) add(skin, theme, sample, width, [{ rule: "overflow", message: `${l.itemOut} icon item(s) stick out of their cell or the window` }]);
            if (sample.startsWith("icons") && l.headShown) add(skin, theme, sample, width, [{ rule: "columns", message: "the column header is shown in the icons view" }]);
            if (l.labelWidth !== null && l.labelWidth < 60) add(skin, theme, sample, width, [{ rule: "columns", message: `the name column is only ${Math.round(l.labelWidth)}px wide` }]);
            // DESIGN.md §6: Size (and Type) drop before Date
            if (!l.date && l.size) add(skin, theme, sample, width, [{ rule: "columns", message: "the Size column is shown after the Date column is dropped" }]);
            if (!l.size && !l.type && l.treeOverflow > 1) add(skin, theme, sample, width, [{ rule: "overflow", message: `the list scrolls sideways by ${l.treeOverflow}px with the Size and Type columns already dropped` }]);
            if (skin !== "win" && l.treeOverflow > 1) add(skin, theme, sample, width, [{ rule: "overflow", message: `the list scrolls sideways by ${l.treeOverflow}px` }]);
          }
          // once a column is dropped it stays dropped as the container narrows
          for (const col of ["date", "size", "type"]) {
            const gone = seen.findIndex((s) => !s[col]);
            if (gone > 0 && seen.slice(gone).some((s) => s[col])) add(skin, theme, sample, seen[gone].width, [{ rule: "columns", message: `the ${col} column comes back at a narrower width` }]);
          }
          log(`${skin} ${theme} ${sample}: ` + seen.map((s) => `${s.width}:${[s.date && "D", s.size && "S", s.type && "T"].filter(Boolean).join("") || "-"}`).join(" "));
        }
      }
    }
  } finally {
    await client.detach().catch(() => {});
    await page.close();
  }
  return findings;
}

module.exports = { audit, inspect, layout, focusRing, SAMPLES, SKINS, THEMES };
