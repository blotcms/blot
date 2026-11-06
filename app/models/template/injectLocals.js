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

function updateFontProperties(targetFont, sourceFont) {
  try {
    // Update core properties
    targetFont.stack = sourceFont.stack;
    targetFont.name = sourceFont.name;
    targetFont.styles = renderFontStyles(sourceFont.styles, sourceFont.id);

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
        updateFontProperties(locals[key], match);
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
