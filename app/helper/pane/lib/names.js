// <span class="pane-name">Finder</span> -> one child per OS, shown by the same data-os CSS
// that skins the windows (DESIGN.md §8). Fail-soft: an unknown term is left as written.

const TERMS = {
  name: { mac: "Finder", win: "File Explorer", linux: "Files" },
  trash: { mac: "Trash", win: "Recycle Bin", linux: "Trash" },
  modifier: { mac: "Command", win: "Ctrl", linux: "Ctrl" },
  rightclick: { mac: "Control-click", win: "right-click", linux: "right-click" },
};

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// The first letter's case follows what the author wrote ("the trash" / "Trash").
const withCase = (word, like) => (like[0] === like[0].toUpperCase() ? word[0].toUpperCase() : word[0].toLowerCase()) + word.slice(1);

function expand(text, key) {
  const t = text.trim();
  const entry = TERMS[key] || Object.values(TERMS).find((e) => Object.values(e).some((v) => v.toLowerCase() === t.toLowerCase()));
  if (!entry) return null;
  const words = ["mac", "win", "linux"].map((os) => withCase(entry[os], t));
  if (new Set(words).size === 1) return escape(words[0]);
  return ["mac", "win", "linux"].map((os, i) => `<span data-os="${os}">${escape(words[i])}</span>`).join("");
}

module.exports = { expand, TERMS };
