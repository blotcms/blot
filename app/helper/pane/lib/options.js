// The options each public function accepts, in one place. An option pane doesn't know (a misspelt
// `iconsize`, `selected` given as an option instead of the `[selected]` row attribute) is ignored,
// so the author could not tell why nothing changed: warn once per function and key instead.
// Never throws.

const COMMON = ["title", "os", "theme", "width", "height", "now"];

const ACCEPTED = {
  folder: [...COMMON, "view", "files", "iconSize", "toolbar"],
  text: [...COMMON, "chrome", "highlight"],
  code: [...COMMON, "chrome", "highlight", "language"],
  // the browser has no `now`: it shows no dates
  browser: [
    ...COMMON.filter((k) => k !== "now"),
    "url",
    "html",
    "src",
    "tint",
    "sandbox",
  ],
};

const HINTS = {
  selected: "mark a row with the [selected] attribute in the tree instead",
};

const warned = new Set();

function check(fn, options) {
  if (!options || typeof options !== "object") return;
  const accepted = ACCEPTED[fn];
  for (const key of Object.keys(options)) {
    if (accepted.includes(key) || options[key] === undefined) continue;
    const id = `${fn}.${key}`;
    if (warned.has(id)) continue;
    warned.add(id);
    const near = accepted.find((k) => k.toLowerCase() === key.toLowerCase());
    const hint = near ? `did you mean "${near}"?` : HINTS[key];
    console.warn(
      `pane: ignoring unknown option "${key}" for pane.${fn}` +
        (hint ? ` (${hint})` : `; it takes ${accepted.join(", ")}`)
    );
  }
}

// the options of `fn` only (the docs build collects every attribute for all kinds)
const pick = (fn, options) =>
  Object.fromEntries(
    Object.entries(options).filter(([k]) => ACCEPTED[fn].includes(k))
  );

module.exports = { ACCEPTED, check, pick, reset: () => warned.clear() };
