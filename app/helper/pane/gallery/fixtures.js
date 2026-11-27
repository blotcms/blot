// What each gallery section shows. Wiring a new pane option in later is an edit to this file:
// add it to the section's `options` (or to a `variants` entry for the logos). Nothing here
// is a pane API: options pane does not know yet are ignored by it, and the gallery says so when
// a variant renders the same as the plain one.
//
// Fixture URLs ("/fixtures/...") are served by the gallery from ./fixtures.

const fs = require("fs");
const path = require("path");

const NOW = "2026-09-20T15:38:00";

// The CV page as static HTML (pane shows it in a sandboxed srcdoc iframe), its images inlined as data
// URIs so the page needs no requests of its own (some embedded browsers block a sandboxed frame's loads).
const CV_DIR = path.join(__dirname, "fixtures/cv");
const CV_HTML = fs
  .readFileSync(path.join(CV_DIR, "index.html"), "utf8")
  .replace(
    /src="([\w.-]+\.png)"/g,
    (m, file) =>
      `src="data:image/png;base64,${fs.readFileSync(path.join(CV_DIR, file)).toString("base64")}"`
  );

// A realistic Blot site folder, for the list view.
const SITE_TREE = `Posts
  Hello world.txt
  Notes on pane.md
  Atlas.html
Images
  Toucan.jpg
  Weaver.jpg
Templates
  Pages
  Entries
Blot.webloc
About.txt
Contact.md
Draft.md
index.html
Logo.png`;

const SITE_FILES = {
  "Hello world.txt": { bytes: 412, modified: "2026-09-20T09:12:00" },
  "Notes on pane.md": { bytes: 3120, modified: "2026-09-19T17:40:00" },
  "Atlas.html": { bytes: 8200, modified: "2026-08-02T11:05:00" },
  "Toucan.jpg": { bytes: 335000, modified: "2026-07-14T08:30:00" },
  "Weaver.jpg": { bytes: 412000, modified: "2026-07-14T08:31:00" },
  "Blot.webloc": { bytes: 128, modified: "2026-06-15T15:12:00" },
  "About.txt": { bytes: 640, modified: "2026-05-01T10:00:00" },
  "Contact.md": { bytes: 210, modified: "2026-04-11T16:20:00" },
  "Draft.md": { bytes: 1090, modified: "2025-10-22T14:59:00" },
  "index.html": { bytes: 500, modified: "2025-03-09T14:33:00" },
  "Logo.png": { bytes: 4800, modified: "2024-01-27T14:20:00" },
};

// The software-hero study: a Finder icons view titled "Blot".
const HERO_TREE = `Blot/
weaver-long-name-finishes.jpg | [img=/fixtures/weaver-long-name-finishes.jpg]
Toucan.jpg | [img=/fixtures/Toucan.jpg]
fly-with-even-longer-name-that-gets-truncated.jpg | [img=/fixtures/fly-with-even-longer-name-that-gets-truncated.jpg]
Post.md
Atlas.html`;

const CODE_SAMPLE = `<!doctype html>
<html lang="en">
  <head>
    <title>Hello from Blot</title>
  </head>
  <body>
    <h1>{{title}}</h1>
    {{#entries}}<p>{{title}}</p>{{/entries}}
  </body>
</html>`;

const TEXT_SAMPLE = `Hello world

This is a plain text file in a Blot folder. Blot turns it into a page on your site; the first line is the title.

Date: 2026-09-20
Tags: notes, pane`;

module.exports = {
  now: NOW,

  finderList: {
    options: { title: "Your site", now: NOW },
    tree: SITE_TREE,
    files: SITE_FILES,
  },

  // The software-hero study: Finder's icons view with the photos as their own icons ([img=URL] row
  // attribute) and the view-mode button in the toolbar, as the study's screenshot has it.
  finderIcons: {
    options: { title: "Blot", view: "icons", toolbar: "view", now: NOW },
    tree: HERO_TREE,
    // true when a render carries the thumbnails (an <img> in the window): the gallery notes it otherwise
    expectsImages: true,
  },

  // The software-browser study: Safari on the CV page (./fixtures/cv, also served at /fixtures/cv/).
  browser: {
    url: "preview-of-cv-on-clara.blot.im",
    src: "/fixtures/cv/",
    title: "Clara Xiao",
    html: CV_HTML,
    render: (pane, theme, fx) =>
      pane.browser({ url: fx.url, html: fx.html, title: fx.title, theme }),
  },

  desktop: {
    options: { view: "desktop", title: "Desktop", now: NOW },
    tree: `Blot/
Post.md
Atlas.html
Toucan.jpg
Notes.txt`,
  },

  // The logos study: the Blot folder icon. A variant may replace the tree (selection is a row
  // attribute, "Blot | [selected]") and add options; one that renders like the plain icon is flagged.
  logos: {
    tree: "Blot",
    base: { view: "desktop", title: "Blot folder", now: NOW },
    variants: [
      { id: "default", label: "Default", options: {} },
      {
        id: "selected",
        label: "Selected",
        tree: "Blot | [selected]",
        options: {},
      },
      { id: "large", label: "Large", options: { iconSize: "large" } },
      {
        id: "large-selected",
        label: "Large, selected",
        tree: "Blot | [selected]",
        options: { iconSize: "large" },
      },
      {
        id: "small",
        label: "Small, selected (list row)",
        tree: "Blot | [selected]",
        options: { view: "list" },
      },
    ],
  },

  editors: {
    text: { title: "Hello world.txt", source: TEXT_SAMPLE },
    code: { title: "index.html", source: CODE_SAMPLE, language: "html" },
  },
};
