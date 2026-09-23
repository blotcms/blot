// Package-level color palettes and font packs.
//
// Presets are editor metadata. They are not template rendering locals. A
// template declares them next to `locals` in package.json:
//
// {
//   "locals": {
//     "background_color": "#ffffff",
//     "text_color": "#111111",
//     "font": { "id": "verdana", "font_size": 16, "line_height": 1.6 },
//     "title_font": { "id": "gill-sans", "font_size": 28 }
//   },
//   "presets": {
//     "colors": [
//       {
//         "id": "classic",
//         "name": "Classic",
//         "values": {
//           "background_color": "#ffffff",
//           "text_color": "#111111"
//         }
//       }
//     ],
//     "fonts": [
//       {
//         "id": "editorial",
//         "name": "Editorial",
//         "values": {
//           "font": { "id": "source-sans" },
//           "title_font": { "id": "vollkorn" }
//         }
//       }
//     ]
//   }
// }
//
// `id` is stable and form-safe. `name` is the accessible label. `values` is a
// patch in the same shape as `locals`. Color presets may only set scalar
// `*_color` locals. Font presets may only patch recognized font locals, and
// only `id`, `font_size` and `line_height`. A font pack should normally set
// `id` alone so the user's size and line height survive.
//
// Nothing here is stored as the selected preset. The sidebar derives that by
// comparing the patch with the current locals. An edit that breaks the match
// becomes Custom, which is a status, not a saved preset.

const Mustache = require("mustache");
const config = require("config");
const FONTS = require("blog/static/fonts");
const {
  DANGEROUS_KEYS,
  FONT_PATCH_PROPS,
  isPlainObject,
  ownKeys,
  isSafeId,
  isColorKey,
  isFontKey,
  normalizeColor,
  presetMatches,
} = require("./preset-values");

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

function entryLabel(type, entry, index) {
  const kind = type === "colors" ? "Color preset" : "Font preset";
  if (entry && typeof entry.name === "string" && entry.name.trim()) {
    return kind + ' "' + entry.name.trim() + '"';
  }
  if (entry && typeof entry.id === "string" && entry.id.trim()) {
    return kind + ' "' + entry.id.trim() + '"';
  }
  return kind + " " + (index + 1);
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

function validateEntry(type, entry, locals, index) {
  const label = entryLabel(type, entry, index);
  const errors = [];

  if (!isPlainObject(entry)) {
    return { entry: null, errors: [label + " must be an object"] };
  }

  if (!isSafeId(entry.id)) {
    errors.push(
      label + ' needs an id made of letters, numbers, hyphens, or underscores'
    );
  }

  if (typeof entry.name !== "string" || !entry.name.trim()) {
    errors.push(label + " needs a name");
  } else if (entry.name.trim().length > 80) {
    errors.push(label + " has a name longer than 80 characters");
  }

  if (!isPlainObject(entry.values)) {
    errors.push(label + " needs a values object");
    return { entry: null, errors };
  }

  const checked =
    type === "colors"
      ? validateColorValues(entry.values, locals)
      : validateFontValues(entry.values, locals);

  checked.errors.forEach((message) => errors.push(label + " " + message));

  if (errors.length || !Object.keys(checked.values).length) {
    return { entry: null, errors };
  }

  return {
    entry: {
      id: entry.id,
      name: entry.name.trim(),
      values: checked.values,
    },
    errors: [],
  };
}

function validatePresetList(type, list, locals, errors) {
  const kind = type === "colors" ? "Color" : "Font";
  if (list == null) return [];
  if (!Array.isArray(list)) {
    errors.push(kind + " presets must be a list");
    return [];
  }

  const seen = new Set();
  const entries = [];

  list.forEach((candidate, index) => {
    const result = validateEntry(type, candidate, locals, index);
    result.errors.forEach((message) => errors.push(message));
    if (!result.entry) return;
    if (seen.has(result.entry.id)) {
      errors.push(
        (type === "colors" ? "Color" : "Font") +
          ' preset id "' +
          result.entry.id +
          '" is duplicated'
      );
      return;
    }
    seen.add(result.entry.id);
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
      errors.push('presets.' + key + " is not a preset list");
    }
  });

  const colors = validatePresetList("colors", presets.colors, safeLocals, errors);
  const fonts = validatePresetList("fonts", presets.fonts, safeLocals, errors);
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
    result[type] = presets[type]
      .filter((entry) => entry && entry.id && entry.name && isPlainObject(entry.values))
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        values: entry.values,
      }));
    if (!result[type].length) delete result[type];
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
  const validated = validatePresets(template && template.presets, locals);
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
  if (!isSafeId(id)) return { error: "That preset is not available" };

  const list = Array.isArray(presets[type]) ? presets[type] : [];
  const found = list.find((entry) => entry && entry.id === id);
  if (!found) return { error: "That preset is not available" };

  const errors = [];
  const entries = validatePresetList(type, [found], locals, errors);
  if (!entries.length) {
    return { error: errors[0] || "That preset is not available" };
  }

  if (type === "fonts") {
    const missing = missingFontIds(entries[0].values);
    if (missing.length) {
      return { error: 'That font pack uses an unknown font "' + missing[0] + '"' };
    }
  }

  return { locals: applyPatch(locals, entries[0].values, type) };
}

module.exports = {
  validatePresets,
  presentPresets,
  applyResolvedPreset,
  toPackagePresets,
  normalizeColor,
  presetMatches,
};
