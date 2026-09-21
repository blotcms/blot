// The adapter interface: render(caseId) -> { html, css, js? } | null
//
// `html` is the window markup (a fragment, placed at the reference's padding);
// `css` is any stylesheet it needs (fixtures may instead inline a <style>).
// Return null when there is nothing to render for that case.
//
// The real pane module plugs in by setting PANE_QA_ADAPTER to a module that
// exports `render(caseId, caseDef)`; until it exists (or when it returns null)
// hand-written pages in qa/fixtures are used. A fixture is looked up as
//   fixtures/<caseId>.html          one exact case
//   fixtures/<os>-<view>.html       both themes (style with prefers-color-scheme;
//                                   the renderer emulates it, and sets
//                                   <html data-os data-theme> too)
// Fixtures freeze their dates to constants (see FROZEN_NOW in lib/constants.js).

const fs = require("fs");
const path = require("path");
const { getCase, FIXTURES_DIR } = require("./lib/cases");

const DATA_OS = { macos: "mac", windows: "win", linux: "linux" };

function fixturePath(c) {
  const candidates = [`${c.id}.html`, `${c.os}-${c.view}.html`];
  for (const name of candidates) {
    const file = path.join(FIXTURES_DIR, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

async function render(caseId) {
  const c = getCase(caseId);
  if (!c) throw new Error(`Unknown case: ${caseId}`);

  // the real module first (PANE_QA_ADAPTER overrides; PANE_QA_FIXTURES=1 skips it)
  if (!process.env.PANE_QA_FIXTURES) {
    const custom = require(process.env.PANE_QA_ADAPTER ? path.resolve(process.env.PANE_QA_ADAPTER) : "./pane-adapter");
    const result = await custom.render(caseId, c);
    if (result) return result;
  }

  const file = fixturePath(c);
  if (!file) return null;
  return { html: fs.readFileSync(file, "utf8"), css: "" };
}

// Fixture files, for the viewer's file watcher and "has adapter" flag.
function fixtureFor(caseId) {
  const c = getCase(caseId);
  return c ? fixturePath(c) : null;
}

// The full page the renderer screenshots (and the viewer shows in an iframe).
// `origin` is where the window's top-left corner sits (CSS px); defaults to the
// nominal padding, but the renderer passes the reference's detected position.
// Chrome on Windows snaps an absolutely positioned box to whole CSS px, so a half-px
// origin (an odd device pixel at 2x, like the Windows capture's 73.5) lands one device
// pixel off. Put the box on the next whole px and pull it back with a transform, which
// is not snapped. (Only Windows: the other captures' origins are whole px or already
// match.)
const place = (o) => {
  const [x, y] = [Math.ceil(o.x), Math.ceil(o.y)];
  return `left:${x}px;top:${y}px` + (x !== o.x || y !== o.y ? `;transform:translate(${o.x - x}px,${o.y - y}px)` : "");
};

function composePage(c, { html, css, js }, origin = { x: c.padding, y: c.padding }) {
  return `<!doctype html>
<html lang="en" data-os="${DATA_OS[c.os]}" data-theme="${c.theme}" style="color-scheme:${c.theme}">
<head>
<meta charset="utf-8">
<style>
html,body{margin:0;background:#808080}
#pane-qa-stage{position:absolute;${c.os === "windows" ? place(origin) : `left:${origin.x}px;top:${origin.y}px`}}
</style>
<style>${css || ""}</style>
${js ? `<script>${js}</script>` : ""}
</head>
<body><div id="pane-qa-stage">${html}</div></body>
</html>`;
}

module.exports = { render, fixtureFor, composePage };
