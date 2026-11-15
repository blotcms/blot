// Font stacks in the registry (and in the locals stored with each template)
// name the web font and sometimes a few Latin system fonts, but no system
// fonts for other scripts. On a site written in Arabic or Japanese the
// browser then picks its own face, which differs between desktop and mobile
// and between headings and body. This adds fonts that cover Arabic and
// Japanese in a matching style, ending with the generic family.
const FALLBACKS = {
  serif: [
    "'Hiragino Mincho ProN'",
    "'Yu Mincho'",
    "'Noto Serif CJK JP'",
    "'Noto Naskh Arabic'",
    "'Geeza Pro'",
    "serif",
  ],
  sans: [
    "'Hiragino Sans'",
    "'Yu Gothic'",
    "'Noto Sans CJK JP'",
    "'Noto Sans Arabic'",
    "'Geeza Pro'",
    "system-ui",
    "sans-serif",
  ],
  mono: ["monospace"],
};

const TRAILING_GENERIC = /(^|,)\s*(serif|sans-serif|monospace|system-ui)\s*$/i;

// Stored font locals often carry only the id and stack (injectLocals copies
// the stack from the registry but not the tags), so take the tags from the
// registry when the local has none.
let registryTags;
function tagsFor(font) {
  if (Array.isArray(font.tags) && font.tags.length) return font.tags;
  if (!registryTags) {
    registryTags = new Map();
    for (const entry of require("./index.json")) {
      if (entry && entry.id) registryTags.set(entry.id, entry.tags || []);
    }
  }
  return registryTags.get(font.id) || [];
}

function kind(font) {
  const tags = tagsFor(font);
  if (tags.includes("mono") || /(^|-)mono$/.test(font.id || "")) return "mono";
  if (tags.includes("serif")) return "serif";
  return "sans";
}

// Returns the stack with the fallback for the font's style placed before
// any generic family it already ends with. Idempotent. Display and script
// faces (tagged "other") and stacks that name cursive or fantasy are
// returned unchanged.
function stackWithFallback(font) {
  const stack = font && typeof font.stack === "string" ? font.stack.trim() : "";
  if (!stack) return stack;
  if (tagsFor(font).includes("other")) return stack;
  if (/(^|,)\s*(cursive|fantasy)\s*(,|$)/i.test(stack)) return stack;

  const style = kind(font);
  if (stack.includes(style === "mono" ? "monospace" : "Geeza Pro")) {
    return stack;
  }

  const base = stack.replace(TRAILING_GENERIC, "").trim();
  return [base, ...FALLBACKS[style]].filter(Boolean).join(", ");
}

module.exports = { stackWithFallback };
