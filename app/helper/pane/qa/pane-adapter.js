// Plugs the real pane module into the QA harness. It hands the module the case's
// view and the sample folder ("Your site" from screenshots/make-fixture.sh, in
// qa/sample.json). Views the module doesn't implement yet (it returns null)
// fall through to fixtures.

const pane = require("../index");
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

// the harness names the default view "default"; the module calls it "list"
const VIEW = { default: "list" };

// The QA windows have the reference's fixed size and are never pinned: the harness
// chooses the skin with <html data-os> and the theme with prefers-color-scheme.
async function render(caseId, c) {
  const result = pane.folder(TREE, {
    title: sample.title,
    view: VIEW[c.view] || c.view,
    files: sample.files,
    now: sample.now,
  });
  if (!result) return null;
  return { html: result.html, ...pane.assets() };
}

module.exports = { render };
