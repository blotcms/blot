// Plugs the real pane module into the QA harness. It hands the module the case's
// view and the sample folder ("Your site" from screenshots/make-fixture.sh, in
// qa/sample.json). Views the module doesn't implement yet (it returns null)
// fall through to fixtures.

const pane = require("../index");
const { referenceGeometry } = require("./lib/geometry");
const sample = require("./sample.json");
const fs = require("fs");
const path = require("path");

// The editor windows show what the capture typed (screenshots/macos.sh opens these files as
// Essay.txt and Snippet.txt), so they come from the same fixture assets.
const asset = (name) =>
  fs
    .readFileSync(
      path.join(__dirname, "..", "screenshots", "fixture-assets", name),
      "utf8"
    )
    .replace(/\s+$/, "");
const EDITORS = {
  text: {
    render: (o) => pane.text(asset("text-sample.txt"), o),
    title: "Essay.txt",
  },
  code: {
    render: (o) =>
      pane.code(asset("code-sample.html"), { ...o, language: "html" }),
    title: "Snippet.txt",
  },
};
// The browser windows show the page the capture loaded (screenshots/macos.sh serves
// fixture-assets/browser-page as https://preview-of-cv-on-clara.blot.im/; the other captures
// are still on example.com until recaptured). The images are inlined: a srcdoc page has no base URL.
const BROWSER_URL = "https://preview-of-cv-on-clara.blot.im/";
// The page's font is system-ui: GNOME Web resolves it to Cantarell, the runner's Chrome to DejaVu Sans, so the
// Linux case names Cantarell (a visitor's own browser shows their own system-ui, which is the point of it).
const browserPage = (os) => {
  const dir = path.join(
    __dirname,
    "..",
    "screenshots",
    "fixture-assets",
    "browser-page"
  );
  return fs
    .readFileSync(path.join(dir, "index.html"), "utf8")
    .replace("system-ui", os === "linux" ? "Cantarell,system-ui" : "system-ui")
    .replace(/src="(images\/[\w-]+\.png)"/g, (m, file) => {
      const data = fs.readFileSync(path.join(dir, file)).toString("base64");
      return `src="data:image/png;base64,${data}"`;
    });
};
const BUILT_EDITORS = ["macos"]; // the OSes whose editor skin exists; the others fall through to fixtures

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
const FLAT = TREE.replace(/\n {2}.*/g, "");
// GNOME Files sorts lower-case names after capitalised ones: index.html comes last
const LINUX_TREE = TREE.replace("index.html\n", "") + "\nindex.html";

const ICONS_TREE = `About.txt
Animation.gif
Blot.webloc
Draft.md
Logo.png
Notes.md
Old report.doc
Photo.jpg
Tasks.org`;

// the harness names the default view "default"; the module calls it "list"
const VIEW = { default: "list", listsel: "list" };

// The Blot study captures (screenshots/macos.sh "hero"): a folder named "Blot" in icon view with the
// study's toolbar, in Finder's by-name order, the photos as real thumbnails (the fixture's own files, as
// data URIs so the page needs no server). hero/iconssel are 64pt icons, large/largesel 128pt; the
// "sel" ones have the folder (and Toucan.jpg at 64pt) selected.
const photo = (name) =>
  `data:image/jpeg;base64,${fs
    .readFileSync(
      path.join(__dirname, "..", "screenshots", "fixture-assets", "hero", name)
    )
    .toString("base64")}`;
const STUDY = {
  hero: { selected: [] },
  iconssel: { selected: ["Blot", "Toucan.jpg"] },
  large: { selected: [], iconSize: "large" },
  largesel: { selected: ["Blot"], iconSize: "large" },
};
const studyTree = (selected) =>
  [
    "Atlas.html",
    "Blot",
    "fly-with-even-longer-name-that-gets-truncated.jpg",
    "Post.md",
    "Toucan.jpg",
    "weaver-long-name-finishes.jpg",
  ]
    .map((name) => {
      const attrs = [
        selected.includes(name) && "[selected]",
        name.endsWith(".jpg") && `[img=${photo(name)}]`,
      ].filter(Boolean);
      return [name, ...attrs].join(" | ");
    })
    .join("\n");

// The QA windows have the reference's fixed size and are never pinned: the harness
// chooses the skin with <html data-os> and the theme with prefers-color-scheme.
async function render(caseId, c) {
  if (c.view === "browser") {
    // every OS: until a skin exists the window falls back to the macOS look, and the case is informational
    const size =
      c.os === "windows" ? (await referenceGeometry(c)).size : c.windowSize;
    const result = pane.browser({
      url: BROWSER_URL,
      html: browserPage(c.os),
      title: "Clara Xiao",
      width: `${size.width}px`,
      height: `${size.height}px`,
    });
    return { html: result.html, ...pane.assets() };
  }
  if (EDITORS[c.view]) {
    if (!BUILT_EDITORS.includes(c.os)) return null;
    const result = EDITORS[c.view].render({
      title: EDITORS[c.view].title,
      height: `${c.windowSize.height}px`,
    });
    return { html: result.html, ...pane.assets() };
  }
  if (STUDY[c.view]) {
    if (c.os !== "macos") return null;
    const { selected, iconSize } = STUDY[c.view];
    const result = pane.folder(studyTree(selected), {
      title: "Blot",
      view: "icons",
      toolbar: "view",
      iconSize,
      width: `${c.windowSize.width}px`,
      height: `${c.windowSize.height}px`,
    });
    return { html: result.html, ...pane.assets() };
  }
  if (c.view === "listsel" && c.os !== "macos") return null;
  if (c.os === "windows" && c.view !== "default") return null; // a view study: fixtures
  // Only the mac skin has an icons view so far; the others use their fixtures. Finder's capture
  // lays its icons out by hand (a fifth column is cut by the window edge, index.html and
  // Report.docx are off-screen), which a reflowing grid can't and shouldn't copy: the tree
  // holds the items the capture shows in its four visible columns.
  if (c.view === "icons" && c.os !== "macos") return null;
  // the Explorer window is 504x367 (frame included), not the nominal 490x360
  const height =
    c.os === "windows"
      ? (await referenceGeometry(c)).size.height
      : c.windowSize.height;
  const tree =
    c.view === "icons"
      ? ICONS_TREE
      : c.view === "listsel"
        ? TREE.replace("Fruits", "Fruits | [selected]")
        : { windows: FLAT, linux: LINUX_TREE }[c.os] || TREE;
  const result = pane.folder(tree, {
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
