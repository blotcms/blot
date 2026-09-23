// Package-level color palettes and font packs.
//
// Presets are editor metadata. They are not template rendering locals. A
// template declares them next to `locals` in package.json:
//
// Presets use their key as both id and label, with values in the same shape as
// `locals`: { colors: { Classic: { background_color: "#fff" } } }.
// Color presets may only set scalar `*_color` locals. Font presets may only
// patch recognized font locals, and only `id`, `font_size` and `line_height`.
// A font pack should normally set `id` alone so the user's sizing survives.
//
// Nothing here is stored as the selected preset. The sidebar derives that by
// comparing the patch with the current locals. An edit that breaks the match
// becomes Custom, which is a status, not a saved preset.

const Mustache = require("mustache");
const config = require("config");
const FONTS = require("blog/static/fonts");
const DANGEROUS_KEYS = Object.create(null);
DANGEROUS_KEYS["__proto__"] = true;
DANGEROUS_KEYS.constructor = true;
DANGEROUS_KEYS.prototype = true;

const FONT_PATCH_PROPS = {
  id: true,
  font_size: true,
  line_height: true,
};

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function ownKeys(value) {
  if (!isPlainObject(value)) return [];
  return Object.keys(value).filter((key) => !DANGEROUS_KEYS[key]);
}

function isColorKey(key) {
  return typeof key === "string" && key.indexOf("_color") !== -1;
}

function isFontKey(key) {
  return key === "font" || (typeof key === "string" && key.indexOf("_font") !== -1);
}

function expandHex(hex) {
  if (hex.length === 3 || hex.length === 4) {
    hex = hex
      .split("")
      .map((character) => character + character)
      .join("");
  }
  if (hex.length === 6) hex += "ff";
  if (hex.length !== 8) return null;
  return "#" + hex;
}

function normalizeColor(input) {
  if (typeof input !== "string") return null;
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(input.trim());
  return match ? expandHex(match[1].toLowerCase()) : null;
}

function numericValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : null;
}

function scalarMatches(declared, current, prop) {
  if (prop === "id") {
    return String(declared == null ? "" : declared) === String(current == null ? "" : current);
  }

  if (prop === "font_size" || prop === "line_height") {
    const left = numericValue(declared);
    const right = numericValue(current);
    return left !== null && right !== null && left === right;
  }

  const declaredColor = normalizeColor(declared);
  const currentColor = normalizeColor(current);
  if (declaredColor && currentColor) return declaredColor === currentColor;

  return (
    String(declared == null ? "" : declared).trim().toLowerCase() ===
    String(current == null ? "" : current).trim().toLowerCase()
  );
}

function valueMatches(declared, current) {
  if (isPlainObject(declared)) {
    if (!isPlainObject(current)) return false;
    const props = ownKeys(declared);
    if (!props.length) return false;
    return props.every((prop) => scalarMatches(declared[prop], current[prop], prop));
  }

  return scalarMatches(declared, current);
}

// True when every property the preset supplies matches the live locals.
// Properties the preset omits are ignored, so a font pack that only sets
// `id` still matches after the user changes size or line height.
function presetMatches(values, locals) {
  const keys = ownKeys(values);
  if (!keys.length) return false;
  return keys.every((key) => valueMatches(values[key], locals && locals[key]));
}


const FONT_BY_ID = new Map();
FONTS.forEach((font) => {
  if (font && font.id) FONT_BY_ID.set(font.id, font);
});

const renderedFontFaces = new Map();

const HEADING_FONT_KEYS = {
  title_font: true,
  heading_font: true,
  header_font: true,
  headline_font: true,
};

const BODY_FONT_KEYS = {
  font: true,
  body_font: true,
  text_font: true,
  paragraph_font: true,
};

function entryLabel(type, id) {
  const kind = type === "colors" ? "Color preset" : "Font preset";
  return kind + ' "' + id + '"';
}

function isColorLocal(key, value) {
  return isColorKey(key) && typeof value === "string";
}

function isFontLocal(key, value) {
  return isFontKey(key) && isPlainObject(value);
}

function validateColorValues(values, locals) {
  const errors = [];
  const clean = {};
  const keys = Object.keys(values);

  if (!keys.length) {
    errors.push("must set at least one color");
    return { errors, values: clean };
  }

  keys.forEach((key) => {
    if (DANGEROUS_KEYS[key]) {
      errors.push('cannot set "' + key + '"');
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(locals, key) || !isColorLocal(key, locals[key])) {
      errors.push('sets "' + key + '", which is not a color on this template');
      return;
    }
    if (typeof values[key] !== "string" || !normalizeColor(values[key])) {
      errors.push('sets "' + key + '" to a value that is not a color');
      return;
    }
    clean[key] = values[key];
  });

  return { errors, values: clean };
}

function validateFontValues(values, locals) {
  const errors = [];
  const clean = {};
  const keys = Object.keys(values);

  if (!keys.length) {
    errors.push("must set at least one font");
    return { errors, values: clean };
  }

  keys.forEach((key) => {
    if (DANGEROUS_KEYS[key]) {
      errors.push('cannot set "' + key + '"');
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(locals, key) || !isFontLocal(key, locals[key])) {
      errors.push('sets "' + key + '", which is not a font on this template');
      return;
    }

    const patch = values[key];
    if (!isPlainObject(patch)) {
      errors.push('sets "' + key + '" to a value that is not a font');
      return;
    }

    const props = Object.keys(patch);
    if (!props.length) {
      errors.push('sets "' + key + '" without a font id, size, or line height');
      return;
    }

    const cleanPatch = {};
    props.forEach((prop) => {
      if (DANGEROUS_KEYS[prop]) {
        errors.push('cannot set "' + key + "." + prop + '"');
        return;
      }
      if (!FONT_PATCH_PROPS[prop]) {
        errors.push(
          'sets "' + key + "." + prop + '", which a font preset cannot change'
        );
        return;
      }
      if (prop === "id") {
        if (typeof patch.id !== "string" || !patch.id.trim()) {
          errors.push('sets "' + key + '.id" to a value that is not a font id');
          return;
        }
        cleanPatch.id = patch.id.trim();
        return;
      }
      if (typeof patch[prop] !== "number" || !Number.isFinite(patch[prop]) || patch[prop] <= 0) {
        errors.push('sets "' + key + "." + prop + '" to a value that is not a positive number');
        return;
      }
      cleanPatch[prop] = patch[prop];
    });

    if (Object.keys(cleanPatch).length) clean[key] = cleanPatch;
  });

  return { errors, values: clean };
}

function validateEntry(type, id, values, locals) {
  const label = entryLabel(type, id);
  const errors = [];

  if (!isSafePresetKey(id)) {
    errors.push(label + " needs a non-empty key of at most 80 characters");
  }

  if (!isPlainObject(values)) {
    return { entry: null, errors: [label + " must be an object"] };
  }

  const checked =
    type === "colors"
      ? validateColorValues(values, locals)
      : validateFontValues(values, locals);

  checked.errors.forEach((message) => errors.push(label + " " + message));

  if (errors.length || !Object.keys(checked.values).length) {
    return { entry: null, errors };
  }

  return {
    entry: {
      id,
      name: id,
      values: checked.values,
    },
    errors: [],
  };
}

function isSafePresetKey(key) {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= 80 &&
    key === key.trim() &&
    !DANGEROUS_KEYS[key] &&
    !/[\x00-\x1f\x7f]/.test(key)
  );
}

function validatePresetMap(type, map, locals, errors) {
  const kind = type === "colors" ? "Color" : "Font";
  if (map == null) return [];
  if (!isPlainObject(map)) {
    errors.push(kind + " presets must be an object");
    return [];
  }

  const entries = [];

  Object.keys(map).forEach((id) => {
    const result = validateEntry(type, id, map[id], locals);
    result.errors.forEach((message) => errors.push(message));
    if (!result.entry) return;
    entries.push(result.entry);
  });

  return entries;
}

function validatePresets(presets, locals) {
  const safeLocals = isPlainObject(locals) ? locals : {};
  if (presets == null) return { presets: {}, errors: [] };
  if (!isPlainObject(presets)) {
    return { presets: {}, errors: ["presets must be an object"] };
  }

  const errors = [];
  Object.keys(presets).forEach((key) => {
    if (key !== "colors" && key !== "fonts") {
      errors.push('presets.' + key + " is not a preset object");
    }
  });

  const colors = validatePresetMap("colors", presets.colors, safeLocals, errors);
  const fonts = validatePresetMap("fonts", presets.fonts, safeLocals, errors);
  const value = {};
  if (colors.length) value.colors = colors;
  if (fonts.length) value.fonts = fonts;
  return { presets: value, errors };
}

function toPackagePresets(presets) {
  if (!isPlainObject(presets)) return null;
  const result = {};
  ["colors", "fonts"].forEach((type) => {
    if (!Array.isArray(presets[type]) || !presets[type].length) return;
    result[type] = {};
    presets[type].forEach((entry) => {
      if (
        !entry ||
        !entry.name ||
        !isSafePresetKey(entry.name) ||
        !isPlainObject(entry.values)
      ) {
        return;
      }
      result[type][entry.name] = entry.values;
    });
    if (!Object.keys(result[type]).length) delete result[type];
  });
  return Object.keys(result).length ? result : null;
}

function fontRole(key) {
  if (HEADING_FONT_KEYS[key] || /title|heading|header|headline/.test(key)) return "heading";
  if (BODY_FONT_KEYS[key] || /body|paragraph/.test(key) || key === "font") return "body";
  return "other";
}

function sampleText(role, key) {
  if (role === "heading") return "Heading";
  if (role === "body") return "Paragraph text";
  const text = String(key).split("_").join(" ");
  const labeled = text.charAt(0).toUpperCase() + text.slice(1);
  return labeled.replace(/ font$/, "");
}

function fontFace(id) {
  const font = FONT_BY_ID.get(id);
  if (!font) return null;
  return {
    id: font.id,
    name: font.name,
    stack: font.stack || font.name || "sans-serif",
    missing: false,
  };
}

function fontSample(key, patch, locals) {
  const id =
    (patch && patch.id) ||
    (locals && locals[key] && locals[key].id) ||
    "";
  const known = fontFace(id);
  const role = fontRole(key);
  if (!known) {
    return {
      key,
      role,
      text: sampleText(role, key),
      id: id,
      name: id || "Unknown font",
      stack: "sans-serif",
      missing: true,
    };
  }
  return {
    key,
    role,
    text: sampleText(role, key),
    id: known.id,
    name: known.name,
    stack: known.stack,
    missing: false,
  };
}

function orderSamples(samples) {
  const rank = { heading: 0, body: 1, other: 2 };
  return samples.slice().sort((a, b) => rank[a.role] - rank[b.role]);
}

function missingFontIds(values) {
  const missing = [];
  ownKeys(values).forEach((key) => {
    const id = values[key] && values[key].id;
    if (id && !FONT_BY_ID.has(id)) missing.push(id);
  });
  return missing;
}

function channel(value) {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
}

function contrastRatio(left, right) {
  if (!left || !right || left.length !== 9 || right.length !== 9) return null;
  if (left.slice(7) !== "ff" || right.slice(7) !== "ff") return null;

  function luminance(hex) {
    return (
      0.2126 * channel(parseInt(hex.slice(1, 3), 16)) +
      0.7152 * channel(parseInt(hex.slice(3, 5), 16)) +
      0.0722 * channel(parseInt(hex.slice(5, 7), 16))
    );
  }

  const lighter = Math.max(luminance(left), luminance(right));
  const darker = Math.min(luminance(left), luminance(right));
  return (lighter + 0.05) / (darker + 0.05);
}

function contrastWarning(values) {
  const pairs = [
    ["text_color", "background_color"],
    ["dark_text_color", "dark_background_color"],
  ];

  for (let i = 0; i < pairs.length; i++) {
    const textKey = pairs[i][0];
    const backgroundKey = pairs[i][1];
    if (values[textKey] == null || values[backgroundKey] == null) continue;
    const ratio = contrastRatio(normalizeColor(values[textKey]), normalizeColor(values[backgroundKey]));
    if (ratio !== null && ratio < 3) return "Low contrast between text and background";
  }

  return "";
}

function colorSwatches(values) {
  return ownKeys(values)
    .map((key) => {
      const value = normalizeColor(values[key]);
      if (!value) return null;
      return { key, value };
    })
    .filter(Boolean);
}

function colorLayout(swatches) {
  const dark = swatches.filter((swatch) => swatch.key.indexOf("dark_") === 0);
  if (!dark.length) {
    return { hasDark: false, rows: [], swatches };
  }
  const light = swatches.filter((swatch) => swatch.key.indexOf("dark_") !== 0);
  const rows = [];
  if (light.length) rows.push({ label: "Light", swatches: light });
  if (dark.length) rows.push({ label: "Dark", swatches: dark });
  return { hasDark: true, rows, swatches };
}

function matchPayload(type, values) {
  const payload = {};
  ownKeys(values).forEach((key) => {
    const declared = values[key];
    if (isPlainObject(declared)) {
      const patch = {};
      ownKeys(declared).forEach((prop) => {
        patch[prop] = declared[prop];
      });
      payload[key] = patch;
      return;
    }
    payload[key] = type === "colors" ? normalizeColor(declared) || declared : declared;
  });
  return JSON.stringify(payload);
}

function accessibleLabel(name, extra) {
  return extra ? name + ". " + extra : name;
}

function presentColors(entries, locals) {
  const items = entries.map((entry) => {
    const layout = colorLayout(colorSwatches(entry.values));
    const warning = contrastWarning(entry.values);
    return {
      id: entry.id,
      name: entry.name,
      values: entry.values,
      disabled: false,
      error: "",
      warning,
      title: accessibleLabel(entry.name, warning),
      ariaLabel: accessibleLabel(entry.name, warning),
      match: matchPayload("colors", entry.values),
      hasDark: layout.hasDark,
      rows: layout.rows,
      swatches: layout.swatches,
      selected: false,
      pressed: "false",
    };
  });

  let selected = false;
  items.forEach((item) => {
    if (!selected && presetMatches(item.values, locals)) {
      item.selected = true;
      item.pressed = "true";
      selected = true;
    }
  });

  const current = colorLayout(colorSwatches(colorLocals(locals)));
  return {
    hasPresets: items.length > 0,
    items,
    custom: items.length
      ? {
          label: "Custom",
          selected: !selected,
          hidden: selected,
          hasDark: current.hasDark,
          rows: current.rows,
          swatches: current.swatches,
        }
      : null,
  };
}

function colorLocals(locals) {
  const values = {};
  Object.keys(locals || {}).forEach((key) => {
    if (isColorLocal(key, locals[key])) values[key] = locals[key];
  });
  return values;
}

function editorFontLocals(locals) {
  const values = {};
  Object.keys(locals || {}).forEach((key) => {
    if (key === "syntax_highlighter_font") return;
    if (!isFontLocal(key, locals[key])) return;
    values[key] = {};
    if (locals[key].id) values[key].id = locals[key].id;
  });
  return values;
}

function presentFonts(entries, locals) {
  const items = entries.map((entry) => {
    const missing = missingFontIds(entry.values);
    const error = missing.length ? 'Unknown font "' + missing[0] + '"' : "";
    const samples = orderSamples(
      ownKeys(entry.values).map((key) => fontSample(key, entry.values[key], locals))
    );
    return {
      id: entry.id,
      name: entry.name,
      values: entry.values,
      disabled: missing.length > 0,
      error,
      warning: "",
      title: accessibleLabel(entry.name, error),
      ariaLabel: accessibleLabel(entry.name, error ? "unavailable: " + error : ""),
      match: matchPayload("fonts", entry.values),
      samples,
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

  const currentValues = editorFontLocals(locals);
  const samples = orderSamples(
    ownKeys(currentValues).map((key) => fontSample(key, currentValues[key], locals))
  );

  return {
    hasPresets: items.length > 0,
    items,
    custom: items.length
      ? {
          label: "Custom",
          selected: !selected,
          hidden: selected,
          samples,
        }
      : null,
  };
}

function renderFontFace(id) {
  if (renderedFontFaces.has(id)) return renderedFontFaces.get(id);
  const font = FONT_BY_ID.get(id);
  let css = "";
  if (font && font.styles) {
    try {
      css = Mustache.render(font.styles, {
        config: { cdn: { origin: config.cdn.origin } },
      });
    } catch (err) {
      css = "";
    }
  }
  css = String(css).replace(/<\/style/gi, "<\\/style");
  renderedFontFaces.set(id, css);
  return css;
}

function collectFontStyles(colors, fonts) {
  const ids = [];
  function addSamples(samples) {
    (samples || []).forEach((sample) => {
      if (sample && sample.id && !sample.missing && ids.indexOf(sample.id) === -1) {
        ids.push(sample.id);
      }
    });
  }
  (fonts.items || []).forEach((item) => addSamples(item.samples));
  if (fonts.custom) addSamples(fonts.custom.samples);
  return ids
    .map(renderFontFace)
    .filter(Boolean)
    .join("");
}

function presentPresets(template) {
  const locals = (template && template.locals) || {};
  const stored = template && template.presets;
  const validated =
    isPlainObject(stored) &&
    (Array.isArray(stored.colors) || Array.isArray(stored.fonts))
      ? { presets: stored, errors: [] }
      : validatePresets(stored, locals);
  const colors = presentColors(validated.presets.colors || [], locals);
  const fonts = presentFonts(validated.presets.fonts || [], locals);
  return {
    colors,
    fonts,
    fontStyles: collectFontStyles(colors, fonts),
    errors: validated.errors,
  };
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isPlainObject(value)) return value;
  const copy = {};
  Object.keys(value).forEach((key) => {
    if (DANGEROUS_KEYS[key]) return;
    copy[key] = cloneValue(value[key]);
  });
  return copy;
}

function applyPatch(locals, values, type) {
  const next = cloneValue(locals) || {};
  ownKeys(values).forEach((key) => {
    const patch = values[key];
    if (type === "fonts") {
      const current = isPlainObject(next[key]) ? cloneValue(next[key]) : {};
      ownKeys(patch).forEach((prop) => {
        if (!FONT_PATCH_PROPS[prop]) return;
        current[prop] = prop === "id" ? String(patch[prop]) : Number(patch[prop]);
      });
      next[key] = current;
      return;
    }
    next[key] = patch;
  });
  return next;
}

function applyResolvedPreset(template, type, id) {
  const locals = (template && isPlainObject(template.locals) && template.locals) || {};
  const presets = (template && isPlainObject(template.presets) && template.presets) || {};

  if (type !== "colors" && type !== "fonts") {
    return { error: "Choose a color palette or a font pack" };
  }
  if (!isSafePresetKey(id)) return { error: "That preset is not available" };

  const list = Array.isArray(presets[type]) ? presets[type] : [];
  const found = list.find((entry) => entry && entry.id === id);
  if (!found) return { error: "That preset is not available" };

  const checked = validateEntry(type, found.id, found.values, locals);
  if (!checked.entry) return { error: checked.errors[0] || "That preset is not available" };

  if (type === "fonts") {
    const missing = missingFontIds(checked.entry.values);
    if (missing.length) {
      return { error: 'That font pack uses an unknown font "' + missing[0] + '"' };
    }
  }

  return { locals: applyPatch(locals, checked.entry.values, type) };
}

module.exports = {
  validatePresets,
  presentPresets,
  applyResolvedPreset,
  toPackagePresets,
  normalizeColor,
  presetMatches,
};
