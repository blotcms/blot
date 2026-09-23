// Shared by the template model and the editor sidebar. Kept free of the font
// registry and config so the dashboard bundle can use the same comparison.

const DANGEROUS_KEYS = {
  __proto__: true,
  constructor: true,
  prototype: true,
};

const FONT_PATCH_PROPS = {
  id: true,
  font_size: true,
  line_height: true,
};

const NAMED_COLORS = {
  transparent: "00000000",
  aliceblue: "f0f8ff",
  antiquewhite: "faebd7",
  aqua: "00ffff",
  aquamarine: "7fffd4",
  azure: "f0ffff",
  beige: "f5f5dc",
  bisque: "ffe4c4",
  black: "000000",
  blanchedalmond: "ffebcd",
  blue: "0000ff",
  blueviolet: "8a2be2",
  brown: "a52a2a",
  burlywood: "deb887",
  cadetblue: "5f9ea0",
  chartreuse: "7fff00",
  chocolate: "d2691e",
  coral: "ff7f50",
  cornflowerblue: "6495ed",
  cornsilk: "fff8dc",
  crimson: "dc143c",
  cyan: "00ffff",
  darkblue: "00008b",
  darkcyan: "008b8b",
  darkgoldenrod: "b8860b",
  darkgray: "a9a9a9",
  darkgreen: "006400",
  darkgrey: "a9a9a9",
  darkkhaki: "bdb76b",
  darkmagenta: "8b008b",
  darkolivegreen: "556b2f",
  darkorange: "ff8c00",
  darkorchid: "9932cc",
  darkred: "8b0000",
  darksalmon: "e9967a",
  darkseagreen: "8fbc8f",
  darkslateblue: "483d8b",
  darkslategray: "2f4f4f",
  darkslategrey: "2f4f4f",
  darkturquoise: "00ced1",
  darkviolet: "9400d3",
  deeppink: "ff1493",
  deepskyblue: "00bfff",
  dimgray: "696969",
  dimgrey: "696969",
  dodgerblue: "1e90ff",
  firebrick: "b22222",
  floralwhite: "fffaf0",
  forestgreen: "228b22",
  fuchsia: "ff00ff",
  gainsboro: "dcdcdc",
  ghostwhite: "f8f8ff",
  gold: "ffd700",
  goldenrod: "daa520",
  gray: "808080",
  green: "008000",
  greenyellow: "adff2f",
  grey: "808080",
  honeydew: "f0fff0",
  hotpink: "ff69b4",
  indianred: "cd5c5c",
  indigo: "4b0082",
  ivory: "fffff0",
  khaki: "f0e68c",
  lavender: "e6e6fa",
  lavenderblush: "fff0f5",
  lawngreen: "7cfc00",
  lemonchiffon: "fffacd",
  lightblue: "add8e6",
  lightcoral: "f08080",
  lightcyan: "e0ffff",
  lightgoldenrodyellow: "fafad2",
  lightgray: "d3d3d3",
  lightgreen: "90ee90",
  lightgrey: "d3d3d3",
  lightpink: "ffb6c1",
  lightsalmon: "ffa07a",
  lightseagreen: "20b2aa",
  lightskyblue: "87cefa",
  lightslategray: "778899",
  lightslategrey: "778899",
  lightsteelblue: "b0c4de",
  lightyellow: "ffffe0",
  lime: "00ff00",
  limegreen: "32cd32",
  linen: "faf0e6",
  magenta: "ff00ff",
  maroon: "800000",
  mediumaquamarine: "66cdaa",
  mediumblue: "0000cd",
  mediumorchid: "ba55d3",
  mediumpurple: "9370db",
  mediumseagreen: "3cb371",
  mediumslateblue: "7b68ee",
  mediumspringgreen: "00fa9a",
  mediumturquoise: "48d1cc",
  mediumvioletred: "c71585",
  midnightblue: "191970",
  mintcream: "f5fffa",
  mistyrose: "ffe4e1",
  moccasin: "ffe4b5",
  navajowhite: "ffdead",
  navy: "000080",
  oldlace: "fdf5e6",
  olive: "808000",
  olivedrab: "6b8e23",
  orange: "ffa500",
  orangered: "ff4500",
  orchid: "da70d6",
  palegoldenrod: "eee8aa",
  palegreen: "98fb98",
  paleturquoise: "afeeee",
  palevioletred: "db7093",
  papayawhip: "ffefd5",
  peachpuff: "ffdab9",
  peru: "cd853f",
  pink: "ffc0cb",
  plum: "dda0dd",
  powderblue: "b0e0e6",
  purple: "800080",
  rebeccapurple: "663399",
  red: "ff0000",
  rosybrown: "bc8f8f",
  royalblue: "4169e1",
  saddlebrown: "8b4513",
  salmon: "fa8072",
  sandybrown: "f4a460",
  seagreen: "2e8b57",
  seashell: "fff5ee",
  sienna: "a0522d",
  silver: "c0c0c0",
  skyblue: "87ceeb",
  slateblue: "6a5acd",
  slategray: "708090",
  slategrey: "708090",
  snow: "fffafa",
  springgreen: "00ff7f",
  steelblue: "4682b4",
  tan: "d2b48c",
  teal: "008080",
  thistle: "d8bfd8",
  tomato: "ff6347",
  turquoise: "40e0d0",
  violet: "ee82ee",
  wheat: "f5deb3",
  white: "ffffff",
  whitesmoke: "f5f5f5",
  yellow: "ffff00",
  yellowgreen: "9acd32",
};

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function ownKeys(value) {
  if (!isPlainObject(value)) return [];
  return Object.keys(value).filter((key) => !DANGEROUS_KEYS[key]);
}

function isSafeId(id) {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id);
}

function isColorKey(key) {
  return typeof key === "string" && key.indexOf("_color") !== -1;
}

function isFontKey(key) {
  return key === "font" || (typeof key === "string" && key.indexOf("_font") !== -1);
}

function toByte(number) {
  const hex = number.toString(16);
  return hex.length === 1 ? "0" + hex : hex;
}

function clampByte(input) {
  const number = Number(input);
  if (!Number.isInteger(number) || number < 0 || number > 255) return null;
  return number;
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

// Hex (short or long, with or without alpha), rgb()/rgba(), and CSS color
// names. Alpha is kept. #fff, #ffffff and #ffffffff are the same color.
function normalizeColor(input) {
  if (typeof input !== "string") return null;

  const value = input.trim().toLowerCase();
  if (!value) return null;

  if (NAMED_COLORS[value]) return expandHex(NAMED_COLORS[value]);

  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value);
  if (hex) return expandHex(hex[1]);

  const rgb =
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/.exec(
      value
    );
  if (!rgb) return null;

  const red = clampByte(rgb[1]);
  const green = clampByte(rgb[2]);
  const blue = clampByte(rgb[3]);
  if (red === null || green === null || blue === null) return null;

  let alpha = 255;
  if (rgb[4] !== undefined) {
    const parsed = Number(rgb[4]);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return null;
    alpha = Math.round(parsed * 255);
  }

  return "#" + toByte(red) + toByte(green) + toByte(blue) + toByte(alpha);
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

module.exports = {
  DANGEROUS_KEYS,
  FONT_PATCH_PROPS,
  isPlainObject,
  ownKeys,
  isSafeId,
  isColorKey,
  isFontKey,
  normalizeColor,
  presetMatches,
};
