const FONTS = require("blog/static/fonts");
const Mustache = require("mustache");
const config = require("config");
const SYNTAX_HIGHLIGHTER_THEMES = require("blog/static/syntax-highlighter");
const clfdate = require("helper/clfdate");
const FONT_PROTECTED_PROPS = ["styles", "name", "stack", "id", "svg", "tags"];
const SYNTAX_HIGHLIGHTER_PROPS_TO_DELETE = [
  "background",
  "tags",
  "name",
  "colors",
];

// The hanging punctuation rules (.pull-double, .push-single, ...) in a
// font's styles are global classes sized to that font's quotes. They're right
// only for the body font, so every other font local drops them, otherwise the
// last font's rules override the body font's.
const TYPESET_RULE =
  /\.(?:pull|push)-(?:double|single)\s*\{[^}]*\}|\.push-double,\.push-single\s*\{[^}]*\}/g;

// Cache for rendered font styles
const fontStylesCache = new Map();

function renderFontStyles(fontStyles, fontId) {
  try {
    // Check cache first
    if (fontStylesCache.has(fontId)) {
      return fontStylesCache.get(fontId);
    }

    // Render and cache if not found
    const renderedStyles = Mustache.render(fontStyles, {
      config: {
        cdn: { origin: config.cdn.origin },
      },
    });

    fontStylesCache.set(fontId, renderedStyles);
    return renderedStyles;
  } catch (error) {
    console.error("Error rendering font styles:", error);
    return "";
  }
}

// The styles stored for a font local: the registry's, rendered, without
// the hanging punctuation rules unless it's the body font. Also used by
// templates/index.js to compare a bundled template with what's stored.
function fontStylesFor(key, registryFont) {
  const styles = renderFontStyles(registryFont.styles, registryFont.id);
  return key === "font" ? styles : styles.replace(TYPESET_RULE, "");
}

function updateFontProperties(targetFont, sourceFont, key) {
  try {
    // Update core properties
    targetFont.stack = sourceFont.stack;
    targetFont.name = sourceFont.name;
    targetFont.styles = fontStylesFor(key, sourceFont);

    // Merge remaining properties
    Object.entries(sourceFont).forEach(([prop, value]) => {
      if (!FONT_PROTECTED_PROPS.includes(prop)) {
        targetFont[prop] = targetFont[prop] || value;
      }
    });
  } catch (error) {
    console.error("Error updating font properties:", error);
  }
}

function processFonts(locals) {
  Object.entries(locals).forEach(([key, value]) => {
    if (!key.includes("_font") && key !== "font") return;

    try {
      const match = FONTS.find((font) => font.id === value.id);

      if (match) {
        updateFontProperties(locals[key], match, key);
      } else {
        console.warn(`No matching font found for ID: ${value.id}`);
      }
    } catch (error) {
      console.error(`Error processing font for key ${key}:`, error);
    }
  });
}

function updateSyntaxHighlighterProperties(target, source, key) {
  try {
    if (!source) {
      console.warn(
        `No matching syntax highlighter theme found for ID: ${target.id}`
      );
      return;
    }

    target.id = source.id;
    target.styles = source.styles;

    Object.entries(source).forEach(([prop, value]) => {
      if (prop === "id" || prop === "styles") return;
      target[prop] = value;
    });

    SYNTAX_HIGHLIGHTER_PROPS_TO_DELETE.forEach((prop) => {
      delete target[prop];
    });
  } catch (error) {
    console.error(
      `Error updating syntax highlighter properties for key ${key}:`,
      error
    );
  }
}

function processSyntaxHighlighter(locals) {
  Object.entries(locals).forEach(([key, value]) => {
    if (!key.includes("_syntax_highlighter") && key !== "syntax_highlighter")
      return;
    if (!value || !value.id) return;

    const match = SYNTAX_HIGHLIGHTER_THEMES.find(
      (theme) => theme.id === value.id
    );
    if (!match) {
      console.warn(
        `No matching syntax highlighter theme found for ID: ${value.id}`
      );
      return;
    }

    updateSyntaxHighlighterProperties(locals[key], match, key);
  });
}

// Initialize cache with all known fonts
function initializeFontStylesCache() {
  try {
    FONTS.forEach((font) => {
      renderFontStyles(font.styles, font.id);
    });
    console.log(
      clfdate(),
      `Font styles cache initialized with ${fontStylesCache.size} entries`
    );
  } catch (error) {
    console.error("Error initializing font styles cache:", error);
  }
}

// Initialize the cache when the module loads
initializeFontStylesCache();

module.exports = (locals) => {
  try {
    processFonts(locals);
    processSyntaxHighlighter(locals);
  } catch (error) {
    console.error("Error processing locals:", error);
  }
};

module.exports.fontStylesFor = fontStylesFor;
