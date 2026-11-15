// Font stacks in the registry (and in the locals stored with each template)
// name the web font and sometimes a few Latin system fonts, but no system
// fonts for other scripts. On a site written in Arabic or Japanese the
// browser then picks its own face, which differs between desktop and mobile
// and between headings and body. This adds fonts that cover Arabic and
// Japanese in a matching style, ending with the generic family.
const FALLBACKS = {
  serif: [
    '"Hiragino Mincho ProN"',
    '"Yu Mincho"',
    '"Noto Serif CJK JP"',
    '"Noto Naskh Arabic"',
    '"Geeza Pro"',
    "serif",
  ],
  sans: [
    '"Hiragino Sans"',
    '"Yu Gothic"',
    '"Noto Sans CJK JP"',
    '"Noto Sans Arabic"',
    '"Geeza Pro"',
    "system-ui",
    "sans-serif",
  ],
  mono: ["monospace"],
};

const TRAILING_GENERIC = /(^|,)\s*(serif|sans-serif|monospace|system-ui)\s*$/i;

function kind(font) {
  const tags = font.tags || [];
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
  if ((font.tags || []).includes("other")) return stack;
  if (/(^|,)\s*(cursive|fantasy)\s*(,|$)/i.test(stack)) return stack;

  const style = kind(font);
  if (stack.includes(style === "mono" ? "monospace" : "Geeza Pro")) {
    return stack;
  }

  const base = stack.replace(TRAILING_GENERIC, "").trim();
  return [base, ...FALLBACKS[style]].filter(Boolean).join(", ");
}

module.exports = { stackWithFallback };
