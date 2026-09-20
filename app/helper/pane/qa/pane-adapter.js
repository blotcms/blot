// Plugs the real pane module into the QA harness: the default view of each
// case, rendered from the sample tree ("Your site" from screenshots/make-fixture.sh).
// Returns null for views the module doesn't implement yet, so fixtures fill in.

const pane = require("../index");

const SAMPLE = `About.txt
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

async function render(caseId, c) {
  if (c.view !== "default") return null;
  return pane.render(SAMPLE, { title: "Your site" });
}

module.exports = { render };
