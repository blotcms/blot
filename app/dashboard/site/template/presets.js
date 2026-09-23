// Presets are compact patches declared in template.locals.presets. The
// settings editor derives the selected card from the live locals; it never
// stores a separate selected-preset value.

const FONTS = require("blog/static/fonts");
const {
  DANGEROUS_KEYS,
  FONT_PATCH_PROPS,
  isPlainObject,
  ownKeys,
  isSafePresetKey,
  normalizeColor,
  presetMatches,
} = require("./preset-utils");

const FONT_BY_ID = new Map();
FONTS.forEach((font) => {
  if (font && font.id) FONT_BY_ID.set(font.id, font);
});

function isColorKey(key) {
  return typeof key === "string" && key.indexOf("_color") !== -1;
}

function isFontKey(key) {
  return key === "font" || (typeof key === "string" && key.indexOf("_font") !== -1);
}

function isColorLocal(key, value) {
  return isColorKey(key) && typeof value === "string";
}

function isFontLocal(key, value) {
  return isFontKey(key) && isPlainObject(value);
}

function labelFor(type, id) {
  return (type === "colors" ? "Color preset" : "Font preset") + ' "' + id + '"';
}

function validatePatch(type, id, patch, locals) {
  const label = labelFor(type, id);
  const errors = [];
  const clean = {};

  if (!isSafePresetKey(id)) {
    errors.push(label + " needs a non-empty key of at most 80 characters");
  }
  if (!isPlainObject(patch)) {
    return { patch: null, errors: errors.concat(label + " must be an object") };
  }

  const keys = Object.keys(patch);
  if (!keys.length) {
    errors.push(label + " must set at least one " + (type === "colors" ? "color" : "font"));
  }

  keys.forEach((key) => {
    if (DANGEROUS_KEYS[key]) {
      errors.push(label + ' cannot set "' + key + '"');
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(locals, key)) {
      errors.push(label + ' sets "' + key + '", which is not on this template');
      return;
    }

    if (type === "colors") {
      if (!isColorLocal(key, locals[key])) {
        errors.push(label + ' sets "' + key + '", which is not a color on this template');
      } else if (typeof patch[key] !== "string" || !normalizeColor(patch[key])) {
        errors.push(label + ' sets "' + key + '" to a value that is not a color');
      } else {
        clean[key] = patch[key];
      }
      return;
    }

    if (key === "syntax_highlighter_font") {
      errors.push(label + ' sets "' + key + '", which is not available to font presets');
      return;
    }
    if (!isFontLocal(key, locals[key])) {
      errors.push(label + ' sets "' + key + '", which is not a font on this template');
      return;
    }

    const fontPatch = patch[key];
    if (!isPlainObject(fontPatch)) {
      errors.push(label + ' sets "' + key + '" to a value that is not a font');
      return;
    }
    const properties = Object.keys(fontPatch);
    if (!properties.length) {
      errors.push(label + ' sets "' + key + '" without a font id, size, or line height');
      return;
    }

    const cleanFontPatch = {};
    properties.forEach((property) => {
      if (DANGEROUS_KEYS[property]) {
        errors.push(label + ' cannot set "' + key + "." + property + '"');
        return;
      }
      if (!FONT_PATCH_PROPS[property]) {
        errors.push(
          label + ' sets "' + key + "." + property + '", which a font preset cannot change'
        );
        return;
      }
      if (property === "id") {
        if (typeof fontPatch.id !== "string" || !fontPatch.id.trim()) {
          errors.push(label + ' sets "' + key + '.id" to a value that is not a font id');
        } else {
          cleanFontPatch.id = fontPatch.id.trim();
        }
        return;
      }
      if (
        typeof fontPatch[property] !== "number" ||
        !Number.isFinite(fontPatch[property]) ||
        fontPatch[property] <= 0
      ) {
        errors.push(
          label +
            ' sets "' +
            key +
            "." +
            property +
            '" to a value that is not a positive number'
        );
        return;
      }
      cleanFontPatch[property] = fontPatch[property];
    });

    if (Object.keys(cleanFontPatch).length) clean[key] = cleanFontPatch;
  });

  return { patch: errors.length ? null : clean, errors };
}

function validatePresetMap(type, map, locals, errors) {
  if (map == null) return {};
  if (!isPlainObject(map)) {
    errors.push((type === "colors" ? "Color" : "Font") + " presets must be an object");
    return {};
  }

  const clean = {};
  Object.keys(map).forEach((id) => {
    const result = validatePatch(type, id, map[id], locals);
    errors.push(...result.errors);
    if (result.patch) clean[id] = result.patch;
  });
  return clean;
}

function validatePresets(presets, locals) {
  const safeLocals = isPlainObject(locals) ? locals : {};
  if (presets == null) return { presets: {}, errors: [] };
  if (!isPlainObject(presets)) return { presets: {}, errors: ["presets must be an object"] };

  const errors = [];
  Object.keys(presets).forEach((key) => {
    if (key !== "colors" && key !== "fonts") {
      errors.push("presets." + key + " is not a preset object");
    }
  });

  const value = {};
  const colors = validatePresetMap("colors", presets.colors, safeLocals, errors);
  const fonts = validatePresetMap("fonts", presets.fonts, safeLocals, errors);
  if (Object.keys(colors).length) value.colors = colors;
  if (Object.keys(fonts).length) value.fonts = fonts;
  return { presets: value, errors };
}

function colorSwatches(values) {
  return ownKeys(values)
    .map((key) => {
      const value = normalizeColor(values[key]);
      return value ? { value } : null;
    })
    .filter(Boolean);
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

function missingFontIds(values) {
  return ownKeys(values)
    .map((key) => values[key] && values[key].id)
    .filter((id) => id && !FONT_BY_ID.has(id));
}

function presentColors(map, locals) {
  const items = Object.keys(map).map((id) => ({
    id,
    name: id,
    values: map[id],
    disabled: false,
    error: "",
    title: id,
    ariaLabel: id,
    match: JSON.stringify(map[id]),
    swatches: colorSwatches(map[id]),
    selected: false,
    pressed: "false",
  }));

  let selected = false;
  items.forEach((item) => {
    if (!selected && presetMatches(item.values, locals)) {
      item.selected = true;
      item.pressed = "true";
      selected = true;
    }
  });

  return {
    hasPresets: items.length > 0,
    items,
    custom: items.length
      ? { label: "Custom", selected: !selected, hidden: selected }
      : null,
  };
}

function presentFonts(map, locals) {
  const items = Object.keys(map).map((id) => {
    const missing = missingFontIds(map[id]);
    const error = missing.length ? 'Unknown font "' + missing[0] + '"' : "";
    return {
      id,
      name: id,
      values: map[id],
      disabled: missing.length > 0,
      error,
      title: error ? id + ". " + error : id,
      ariaLabel: error ? id + ". unavailable: " + error : id,
      match: JSON.stringify(map[id]),
      samples: ownKeys(map[id]).map((key) => fontPreview(key, map[id][key], locals)),
      selected: false,
      pressed: "false",
    };
  });

  let selected = false;
  items.forEach((item) => {
    if (!selected && !item.disabled && presetMatches(item.values, locals)) {
      item.selected = true;
      item.pressed = "true";
      selected = true;
    }
  });

  const current = {};
  Object.keys(locals).forEach((key) => {
    if (key !== "syntax_highlighter_font" && isFontLocal(key, locals[key])) {
      current[key] = { id: locals[key].id };
    }
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
  const validated = validatePresets(locals.presets, locals);
  return {
    colors: presentColors(validated.presets.colors || {}, locals),
    fonts: presentFonts(validated.presets.fonts || {}, locals),
    errors: validated.errors,
  };
}

function resolvePreset(template, type, id) {
  const locals = (template && isPlainObject(template.locals) && template.locals) || {};
  const presets = (isPlainObject(locals.presets) && locals.presets) || {};

  if (type !== "colors" && type !== "fonts") {
    return { error: "Choose a color palette or a font pack" };
  }
  if (!isSafePresetKey(id)) return { error: "That preset is not available" };

  const map = isPlainObject(presets[type]) ? presets[type] : {};
  if (!Object.prototype.hasOwnProperty.call(map, id)) {
    return { error: "That preset is not available" };
  }

  const checked = validatePatch(type, id, map[id], locals);
  if (!checked.patch) return { error: checked.errors[0] || "That preset is not available" };

  if (type === "fonts") {
    const missing = missingFontIds(checked.patch);
    if (missing.length) {
      return { error: 'That font pack uses an unknown font "' + missing[0] + '"' };
    }
  }

  return { values: checked.patch };
}

module.exports = {
  validatePresets,
  presentPresets,
  resolvePreset,
  normalizeColor,
  presetMatches,
};
