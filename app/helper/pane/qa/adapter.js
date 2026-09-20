// The adapter interface: render(caseId) -> { html, css } | null
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

  if (process.env.PANE_QA_ADAPTER) {
    const custom = require(path.resolve(process.env.PANE_QA_ADAPTER));
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
function composePage(c, { html, css }, origin = { x: c.padding, y: c.padding }) {
  return `<!doctype html>
<html lang="en" data-os="${c.os}" data-theme="${c.theme}" style="color-scheme:${c.theme}">
<head>
<meta charset="utf-8">
<style>
html,body{margin:0;background:#808080}
#pane-qa-stage{position:absolute;left:${origin.x}px;top:${origin.y}px}
</style>
<style>${css || ""}</style>
</head>
<body><div id="pane-qa-stage">${html}</div></body>
</html>`;
}

module.exports = { render, fixtureFor, composePage };
