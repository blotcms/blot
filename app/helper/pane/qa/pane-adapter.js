// Plugs the real pane module into the QA harness. It hands the module the case's
// view and the sample folder ("Your site" from screenshots/make-fixture.sh, in
// qa/sample.json). Views the module doesn't implement yet (it returns null)
// fall through to fixtures.

const pane = require("../index");
const { referenceGeometry } = require("./lib/geometry");
const sample = require("./sample.json");

const TREE = `About.txt
Animation.gif
Blot.webloc
Draft.md
Fruits
  Apple.md
index.html
Logo.png
Notes.md
Old report.doc
Photo.jpg
Plan.gdoc
Report.docx
Tasks.org`;

// Explorer's Details view can't expand a folder, so its window lists the top level only
// (the reference says "13 items": Fruits is a row with no children).
const FLAT = TREE.replace(/\n  .*/g, "");
// GNOME Files sorts lower-case names after capitalised ones: index.html comes last
const LINUX_TREE = TREE.replace("index.html\n", "") + "\nindex.html";

// the harness names the default view "default"; the module calls it "list"
const VIEW = { default: "list" };

// The QA windows have the reference's fixed size and are never pinned: the harness
// chooses the skin with <html data-os> and the theme with prefers-color-scheme.
async function render(caseId, c) {
  if (c.os === "windows" && c.view !== "default") return null; // a view study: fixtures
  // the Explorer window is 504x367 (frame included), not the nominal 490x360
  const height = c.os === "windows" ? (await referenceGeometry(c)).size.height : c.windowSize.height;
  const result = pane.folder({ windows: FLAT, linux: LINUX_TREE }[c.os] || TREE, {
    title: sample.title,
    view: VIEW[c.view] || c.view,
    files: sample.files,
    now: sample.now,
    height: `${height}px`,
  });
  if (!result) return null;
  return { html: result.html, ...pane.assets() };
}

module.exports = { render };
