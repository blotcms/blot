// The case registry: one entry per reference screenshot, derived by scanning
// reference/ so new captures show up without editing anything.
//
//   id             stable, e.g. macos-dark-icons (default view: macos-dark)
//   os, theme, view, scale
//   referencePath  absolute path of the real screenshot (read-only)
//   renderedPath   where the rendering is written (rendered/<os>/<same name>)
//   imageSize      reference size in image pixels
//   logicalSize    imageSize / scale (CSS px)
//   padding        desktop around the window in the capture (CSS px)
//   windowSize     nominal window size (logicalSize - 2 * padding)
//   masks          window-relative regions excluded from comparison (CSS px)
//   regions        window-relative regions compared separately (CSS px)
//
// Masks and regions are {x|right, y|bottom, w, h}; w/h of null run to the
// window edge. Override the masks of one case in masks.json ({ "<id>": [...] }).

const fs = require("fs");
const path = require("path");

const PANE_DIR = path.join(__dirname, "..", "..");
const REFERENCE_DIR = path.join(PANE_DIR, "reference");
const RENDERED_DIR = path.join(PANE_DIR, "rendered");
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");
const OUT_DIR = path.join(__dirname, "..", "out");
const OS_LIST = ["macos", "windows", "linux"];
const PADDING = { macos: 96, windows: 80, linux: 96 };
const NAME = /^(macos|windows|linux)-(light|dark)@(\d+)x(?:-([a-z]+))?\.png$/;

function pngSize(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

// Views that show a date column. Its text is time-dependent ("Today at 3:38 PM",
// "9/20/2026 3:37 PM", "Today 15:38"), so the whole column is masked, which
// also covers every "today"-relative row. Columns are measured on the 490px
// captures; Linux columns are measured from the right edge so the wider
// -sidebar capture lines up too. Tune here or in masks.json.
function defaultMasks(os, view) {
  if (os === "macos" && view === "default") {
    return [{ name: "date-column", kind: "time", x: 205, y: 80, w: 158, h: null }];
  }
  if (os === "windows" && view === "default") {
    return [{ name: "date-column", kind: "time", x: 272, y: 100, w: 112, h: 235 }];
  }
  if (os === "linux" && (view === "default" || view === "sidebar")) {
    return [{ name: "date-column", kind: "time", right: 74, y: 76, w: 100, h: 380 }];
  }
  return [];
}

// Chrome is compared strictly, content (text) loosely. Heights are of the bars
// in the references; the default views have an extra column header row.
function defaultRegions(os, view) {
  if (os === "macos") {
    const top = view === "default" ? 80 : 52;
    return [
      { name: "titlebar", kind: "chrome", x: 0, y: 0, w: null, h: top },
      { name: "content", kind: "text", x: 0, y: top, w: null, h: null },
    ];
  }
  if (os === "windows") {
    return [
      { name: "toolbars", kind: "chrome", x: 0, y: 0, w: null, h: 136 },
      { name: "content", kind: "text", x: 0, y: 136, w: null, h: 199 },
      { name: "statusbar", kind: "chrome", bottom: 0, y: 0, x: 0, w: null, h: 26 },
    ];
  }
  return [
    { name: "headerbar", kind: "chrome", x: 0, y: 0, w: null, h: 48 },
    { name: "content", kind: "text", x: 0, y: 48, w: null, h: 412 },
    { name: "footer", kind: "chrome", bottom: 0, x: 0, w: null, h: 56 },
  ];
}

function overrides() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "masks.json"), "utf8"));
  } catch (e) {
    return {};
  }
}

function loadCases(referenceDir = REFERENCE_DIR) {
  const custom = overrides();
  const cases = [];
  for (const os of OS_LIST) {
    const dir = path.join(referenceDir, os);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => NAME.test(f));
    // light before dark, the default view first, then alphabetical
    const key = (f) => {
      const [, , theme, , view] = NAME.exec(f);
      return `${theme === "light" ? 0 : 1}-${view ? "1" + view : "0"}`;
    };
    for (const file of files.sort((a, b) => key(a).localeCompare(key(b)))) {
      const m = NAME.exec(file);
      if (!m) continue;
      const [, , theme, scaleText, viewName] = m;
      const scale = parseInt(scaleText, 10);
      const view = viewName || "default";
      const id = `${os}-${theme}${viewName ? "-" + viewName : ""}${scale === 2 ? "" : "@" + scale + "x"}`;
      const referencePath = path.join(dir, file);
      const imageSize = pngSize(referencePath);
      const padding = PADDING[os];
      const logicalSize = { width: imageSize.width / scale, height: imageSize.height / scale };
      cases.push({
        id,
        os,
        theme,
        view,
        scale,
        file,
        referencePath,
        renderedPath: path.join(RENDERED_DIR, os, file),
        imageSize,
        logicalSize,
        padding,
        windowSize: {
          width: logicalSize.width - 2 * padding,
          height: logicalSize.height - 2 * padding,
        },
        masks: custom[id] || defaultMasks(os, view),
        regions: defaultRegions(os, view),
      });
    }
  }
  return cases;
}

function getCase(id, cases = loadCases()) {
  return cases.find((c) => c.id === id) || null;
}

// A case as JSON-safe data with paths relative to the pane directory.
function describe(c) {
  return {
    id: c.id,
    os: c.os,
    theme: c.theme,
    view: c.view,
    scale: c.scale,
    reference: path.relative(PANE_DIR, c.referencePath),
    rendered: path.relative(PANE_DIR, c.renderedPath),
    imageSize: c.imageSize,
    logicalSize: c.logicalSize,
    padding: c.padding,
    windowSize: c.windowSize,
    masks: c.masks,
    regions: c.regions,
  };
}

module.exports = {
  PANE_DIR,
  REFERENCE_DIR,
  RENDERED_DIR,
  FIXTURES_DIR,
  OUT_DIR,
  OS_LIST,
  loadCases,
  getCase,
  describe,
  defaultMasks,
  defaultRegions,
};
