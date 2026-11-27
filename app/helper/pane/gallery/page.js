// Builds the gallery page from the current pane code (passed in, freshly required).

const fs = require("fs");
const path = require("path");

const REFERENCE_DIR = path.join(__dirname, "..", "reference");
const OSES = [
  { key: "mac", label: "macOS", dir: "macos" },
  { key: "win", label: "Windows", dir: "windows" },
  { key: "linux", label: "Linux", dir: "linux" },
];
const THEMES = ["light", "dark"];
const MODES = [
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
  { key: "both", label: "Both" },
];

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]
  );

// "/reference/macos/macos-light@2x-icons.png" if the capture exists, else ""
function referenceUrl(os, theme, suffix) {
  if (suffix === null || suffix === undefined) return "";
  const file = `${os.dir}-${theme}@2x${suffix}.png`;
  return fs.existsSync(path.join(REFERENCE_DIR, os.dir, file))
    ? `/reference/${os.dir}/${file}`
    : "";
}

const note = (text) => `<p class="note">${esc(text)}</p>`;

// What a window renders as: pane's html, or a note when pane returned null or threw.
function windowHtml(make, label) {
  try {
    const result = make();
    if (result && result.html) return { html: result.html };
    return { note: `${label} is not built on this branch yet.` };
  } catch (err) {
    return { note: `${label} failed to render: ${err.message}` };
  }
}

// The sections, as data: each item renders once per theme, pinned with `theme`.
function sections(pane, fx) {
  const folder = (tree, options, theme) =>
    windowHtml(() => pane.folder(tree, { ...options, theme }), "This view");

  const logoRender = (variant, theme) => {
    const options = { ...fx.logos.base, ...variant.options };
    const out = folder(variant.tree || fx.logos.tree, options, theme);
    if (variant.id === "default" || !out.html) return out;
    const plain = folder(fx.logos.tree, fx.logos.base, theme);
    if (plain.html === out.html)
      out.caption =
        "Same as Default: this option is not built on this branch yet.";
    return out;
  };

  const iconsRender = (theme) => {
    const out = folder(fx.finderIcons.tree, fx.finderIcons.options, theme);
    if (out.html && fx.finderIcons.expectsImages && !/<img\b/.test(out.html))
      out.caption =
        "Plain icons: image thumbnails are not built on this branch yet.";
    return out;
  };

  return [
    {
      id: "finder",
      title: "Finder",
      blurb:
        "The list view of a Blot site folder, and the icons-view hero from the software-hero study.",
      items: [
        {
          label: "List view",
          ref: "",
          render: (theme) =>
            folder(
              fx.finderList.tree,
              {
                ...fx.finderList.options,
                files: fx.finderList.files,
              },
              theme
            ),
        },
        { label: "Icons view (hero)", ref: "-icons", render: iconsRender },
      ],
    },
    {
      id: "browser",
      title: "Browser",
      blurb:
        "The CV page from the software-browser study, in pane's browser window.",
      items: [
        {
          label: "Safari-style window",
          ref: "-browser",
          render: (theme) =>
            typeof pane.browser === "function"
              ? windowHtml(
                  () => fx.browser.render(pane, theme, fx.browser),
                  "pane.browser"
                )
              : { note: "pane.browser is not built on this branch yet." },
        },
      ],
    },
    {
      id: "desktop",
      title: "Desktop icons",
      blurb:
        'view: "desktop" over a wallpaper-like background. Positioning is the caller\'s job; here a fixed box.',
      wallpaper: true,
      flush: true, // the capture is cropped to the icon grid, with no desktop margin
      items: [
        {
          label: "Icons on the desktop",
          ref: "-desktop",
          render: (theme) => folder(fx.desktop.tree, fx.desktop.options, theme),
        },
      ],
    },
    {
      id: "logos",
      title: "Logos",
      blurb:
        "The Blot folder icon in each state and size of the logos study, light and dark.",
      wallpaper: true,
      compact: true,
      items: fx.logos.variants.map((v) => ({
        label: v.label,
        ref: null,
        render: (theme) => logoRender(v, theme),
      })),
    },
    {
      id: "editors",
      title: "Editors",
      blurb: "The text and code windows.",
      items: [
        {
          label: "Text",
          ref: "-text",
          render: (theme) =>
            windowHtml(
              () =>
                pane.text(fx.editors.text.source, {
                  title: fx.editors.text.title,
                  now: fx.now,
                  theme,
                }),
              "The text window"
            ),
        },
        {
          label: "Code",
          ref: "-code",
          render: (theme) =>
            windowHtml(
              () =>
                pane.code(fx.editors.code.source, {
                  title: fx.editors.code.title,
                  language: fx.editors.code.language,
                  now: fx.now,
                  theme,
                }),
              "The code window"
            ),
        },
      ],
    },
  ];
}

function pairHtml(section, item, theme, osKey) {
  const out = item.render(theme);
  const refs = OSES.map((os) => referenceUrl(os, theme, item.ref));
  const dataRefs = OSES.map(
    (os, i) => ` data-ref-${os.key}="${esc(refs[i])}"`
  ).join("");
  const current = refs[OSES.findIndex((o) => o.key === osKey)];
  const rendered = out.html
    ? section.wallpaper
      ? `<div class="wallpaper${section.compact ? " compact" : ""}">${out.html}</div>`
      : out.html
    : note(out.note);
  const reference =
    item.ref === null
      ? ""
      : `<div class="ref"${dataRefs}>
          <img alt="Reference screenshot" ${current ? `src="${esc(current)}"` : "hidden"}>
          <p class="note"${current ? " hidden" : ""}>no capture for this OS yet</p>
        </div>`;
  return `<div class="pair" data-theme="${theme}">
    <div class="stage">
      <div class="render">${rendered}</div>
      ${reference}
    </div>
    <p class="caption">${esc(out.caption || "")}</p>
  </div>`;
}

const sectionClass = (s) => {
  const c = [s.compact && "grid", s.flush && "flush"].filter(Boolean);
  return c.length ? ` class="${c.join(" ")}"` : "";
};

function sectionHtml(section, osKey) {
  const hasRefs = section.items.some((i) => i.ref !== null);
  const items = section.items
    .map(
      (item) => `<div class="item">
        <h3>${esc(item.label)}</h3>
        <div class="pairs">${THEMES.map((t) => pairHtml(section, item, t, osKey)).join("")}</div>
      </div>`
    )
    .join("");
  const controls = hasRefs
    ? `<div class="compare" role="group" aria-label="Compare ${esc(section.title)} with the reference">
        <button type="button" data-compare="side" aria-pressed="true">Side by side</button>
        <button type="button" data-compare="overlay" aria-pressed="false">Overlay</button>
        <label class="blend" hidden>Reference <input type="range" min="0" max="100" value="50" aria-label="Reference opacity"></label>
      </div>`
    : "";
  return `<section id="${section.id}" data-compare="side"${sectionClass(section)}>
    <header><div><h2>${esc(section.title)}</h2><p>${esc(section.blurb)}</p></div>${controls}</header>
    <div class="items">${items}</div>
  </section>`;
}

function page({ pane, fixtures, os: osQuery, theme: themeQuery }) {
  const osKey = OSES.some((o) => o.key === osQuery) ? osQuery : "mac";
  const mode = MODES.some((m) => m.key === themeQuery) ? themeQuery : "both";
  const { css, js } = pane.assets();
  const secs = sections(pane, fixtures);
  const tabs = OSES.map(
    (o) =>
      `<a role="tab" href="?os=${o.key}&amp;theme=${mode}" data-os="${o.key}" aria-selected="${o.key === osKey}">${o.label}</a>`
  ).join("");
  const modes = MODES.map(
    (m) =>
      `<button type="button" data-mode="${m.key}" aria-pressed="${m.key === mode}">${m.label}</button>`
  ).join("");
  const nav = secs
    .map((s) => `<a href="#${s.id}">${esc(s.title)}</a>`)
    .join("");
  return `<!doctype html>
<html lang="en" data-os="${osKey}" data-mode="${mode}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pane gallery</title>
<script>${js}</script>
<style>${css}</style>
<link rel="stylesheet" href="/_gallery/gallery.css">
</head>
<body>
<header class="top">
  <div class="bar">
    <h1>pane <span>gallery</span></h1>
    <div class="tabs" role="tablist" aria-label="Operating system">${tabs}</div>
    <div class="modes" role="group" aria-label="Theme">${modes}</div>
  </div>
  <nav aria-label="Sections">${nav}</nav>
</header>
<main>${secs.map((s) => sectionHtml(s, osKey)).join("\n")}</main>
<script src="/_gallery/gallery.js" defer></script>
</body>
</html>`;
}

module.exports = { page, OSES };
