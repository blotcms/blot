// What each gallery section shows. Wiring a new pane option in later is an edit to this file:
// add it to the section's `options` (or to a `variants` entry for the logos). Nothing here
// is a pane API: options pane does not know yet are ignored by it, and the gallery says so when
// a variant renders the same as the plain one.
//
// Fixture URLs ("/fixtures/...") are served by the gallery from ./fixtures.

const NOW = "2026-09-20T15:38:00";

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
weaver-long-name-finishes.jpg
Toucan.jpg
fly-with-even-longer-name-that-gets-truncated.jpg
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

  // Thumbnails: `thumbnails` is what the pane-blot-icons branch is expected to take (file name -> image URL);
  // pane ignores it until then and the gallery shows plain icons. Rename it here when the name is fixed.
  finderIcons: {
    options: {
      title: "Blot",
      view: "icons",
      now: NOW,
      thumbnails: {
        "weaver-long-name-finishes.jpg":
          "/fixtures/weaver-long-name-finishes.jpg",
        "Toucan.jpg": "/fixtures/Toucan.jpg",
        "fly-with-even-longer-name-that-gets-truncated.jpg":
          "/fixtures/fly-with-even-longer-name-that-gets-truncated.jpg",
      },
    },
    tree: HERO_TREE,
    // true when a render carries the thumbnails (an <img> in the window): the gallery notes it otherwise
    expectsImages: true,
  },

  // The pane-browser branch's window. `render` is the one place that knows its signature.
  browser: {
    url: "preview-of-cv-on-clara.blot.im",
    src: "/fixtures/cv/",
    title: "Clara Xiao",
    render: (pane, theme, fx) =>
      pane.browser(
        { url: fx.url, src: fx.src, title: fx.title },
        { theme, title: fx.title, url: fx.url, src: fx.src }
      ),
  },

  desktop: {
    options: { view: "desktop", title: "Desktop", now: NOW },
    tree: `Blot/
Post.md
Atlas.html
Toucan.jpg
Notes.txt`,
  },

  // The logos study: the Blot folder icon. Every variant is rendered through the same call; a variant
  // whose options pane does not know yet renders like the plain one, and the gallery says so.
  logos: {
    tree: "Blot/",
    base: { view: "desktop", title: "Blot folder", now: NOW },
    variants: [
      { id: "default", label: "Default", options: {} },
      { id: "selected", label: "Selected", options: { selected: ["Blot"] } },
      { id: "large", label: "Large", options: { size: "large" } },
      {
        id: "large-selected",
        label: "Large, selected",
        options: { size: "large", selected: ["Blot"] },
      },
      { id: "small", label: "Small", options: { size: "small" } },
    ],
  },

  editors: {
    text: { title: "Hello world.txt", source: TEXT_SAMPLE },
    code: { title: "index.html", source: CODE_SAMPLE, language: "html" },
  },
};
