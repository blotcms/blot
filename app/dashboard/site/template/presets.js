// Presets are compact patches declared in template.locals.presets, written by
// whoever authors the template's package.json. They aren't validated: a
// preset that doesn't fit the current locals just fails to build a tile and
// is skipped, the same way a broken swatch or an unknown font id already is.
//
// The settings editor derives the selected card from the live locals; it
// never stores a separate selected-preset value.

const FONTS = require("blog/static/fonts");
const { isPlainObject, ownKeys, normalizeColor, presetMatches } = require("./preset-utils");

const FONT_BY_ID = new Map();
FONTS.forEach((font) => {
  if (font && font.id) FONT_BY_ID.set(font.id, font);
});

function isFontLocal(key, value) {
  const isFontKey = key === "font" || key.indexOf("_font") !== -1;
  return isFontKey && key !== "syntax_highlighter_font" && isPlainObject(value) && value.id;
}

function colorSwatches(patch) {
  return ownKeys(patch)
    .map((key) => {
      const value = normalizeColor(patch[key]);
      return value ? { value } : null;
    })
    .filter(Boolean);
}

function colorSample(patch) {
  const background = normalizeColor(patch.background_color);
  const text = normalizeColor(patch.text_color);
  if (!background || !text) return null;
  return { background, text, link: normalizeColor(patch.links_color) || text };
}

function colorFields(patch) {
  return ownKeys(patch).map((key) => ({ name: "locals." + key, value: patch[key] }));
}

function fontFields(patch) {
  const fields = [];
  ownKeys(patch).forEach((key) => {
    ownKeys(patch[key]).forEach((property) => {
      fields.push({ name: "locals." + key + "." + property, value: patch[key][property] });
    });
  });
  return fields;
}

function fontPreview(key, patch, locals) {
  const id = (patch && patch.id) || (locals[key] && locals[key].id) || "";
  const font = FONT_BY_ID.get(id);
  return {
    key,
    name: (font && font.name) || id || "Unknown font",
    svg: (font && font.svg) || "",
    stack: (font && font.stack) || "sans-serif",
  };
}

function missingFontIds(patch) {
  return ownKeys(patch)
    .map((key) => patch[key] && patch[key].id)
    .filter((id) => id && !FONT_BY_ID.has(id));
}

function markSelected(items, locals) {
  let selected = false;
  items.forEach((item) => {
    if (!selected && !item.disabled && presetMatches(item.values, locals)) {
      item.selected = true;
      item.pressed = "true";
      selected = true;
    }
  });
  return selected;
}

function presentColors(map, locals) {
  const items = [];

  Object.keys(map).forEach((id) => {
    try {
      const patch = map[id];
      const swatches = colorSwatches(patch);
      if (!swatches.length) return;
      items.push({
        id,
        name: id,
        group: "colors",
        values: patch,
        fields: colorFields(patch),
        disabled: false,
        error: "",
        title: id,
        ariaLabel: id,
        match: JSON.stringify(patch),
        swatches,
        sample: colorSample(patch),
        selected: false,
        pressed: "false",
      });
    } catch (e) {
      // Malformed preset in package.json; skip it rather than breaking the sidebar.
    }
  });

  markSelected(items, locals);

  return {
    hasPresets: items.length > 0,
    items,
  };
}

function presentFonts(map, locals) {
  const items = [];

  Object.keys(map).forEach((id) => {
    try {
      const patch = map[id];
      const samples = ownKeys(patch).map((key) => fontPreview(key, patch[key], locals));
      if (!samples.length) return;
      const missing = missingFontIds(patch);
      const error = missing.length ? 'Unknown font "' + missing[0] + '"' : "";
      items.push({
        id,
        name: id,
        group: "fonts",
        values: patch,
        fields: fontFields(patch),
        disabled: missing.length > 0,
        error,
        title: error ? id + ". " + error : id,
        ariaLabel: error ? id + ". unavailable: " + error : id,
        match: JSON.stringify(patch),
        samples,
        selected: false,
        pressed: "false",
      });
    } catch (e) {
      // Malformed preset in package.json; skip it rather than breaking the sidebar.
    }
  });

  const selected = markSelected(items, locals);

  const current = {};
  Object.keys(locals).forEach((key) => {
    if (isFontLocal(key, locals[key])) current[key] = { id: locals[key].id };
  });

  return {
    hasPresets: items.length > 0,
    items,
    custom: items.length
      ? {
          label: "Custom",
          selected: !selected,
          hidden: selected,
          samples: ownKeys(current).map((key) => fontPreview(key, current[key], locals)),
        }
      : null,
  };
}

function presentPresets(template) {
  const locals = (template && isPlainObject(template.locals) && template.locals) || {};
  const presets = isPlainObject(locals.presets) ? locals.presets : {};
  return {
    colors: presentColors(isPlainObject(presets.colors) ? presets.colors : {}, locals),
    fonts: presentFonts(isPlainObject(presets.fonts) ? presets.fonts : {}, locals),
  };
}

module.exports = {
  presentPresets,
  normalizeColor,
  presetMatches,
};
