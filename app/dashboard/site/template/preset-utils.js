const tinyColor = require("../../../helper/tinyColor");

const DANGEROUS_KEYS = Object.create(null);
DANGEROUS_KEYS.__proto__ = true;
DANGEROUS_KEYS.constructor = true;
DANGEROUS_KEYS.prototype = true;

const FONT_PATCH_PROPS = Object.freeze({
  id: true,
  font_size: true,
  line_height: true,
});

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function ownKeys(value) {
  if (!isPlainObject(value)) return [];
  return Object.keys(value).filter((key) => !DANGEROUS_KEYS[key]);
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

function normalizeColor(value) {
  if (typeof value !== "string") return null;
  const color = tinyColor(value.trim());
  return color.isValid() ? color.toHex8String().toLowerCase() : null;
}

function numericValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function scalarMatches(declared, current, property) {
  if (property === "id") {
    return String(declared == null ? "" : declared) === String(current == null ? "" : current);
  }

  if (property === "font_size" || property === "line_height") {
    const left = numericValue(declared);
    const right = numericValue(current);
    return left !== null && right !== null && left === right;
  }

  const leftColor = normalizeColor(declared);
  const rightColor = normalizeColor(current);
  if (leftColor && rightColor) return leftColor === rightColor;

  return String(declared == null ? "" : declared).trim().toLowerCase() ===
    String(current == null ? "" : current).trim().toLowerCase();
}

function valuesMatch(declared, current) {
  if (!isPlainObject(declared)) return scalarMatches(declared, current);
  if (!isPlainObject(current)) return false;
  const properties = ownKeys(declared);
  return properties.length > 0 && properties.every((property) =>
    scalarMatches(declared[property], current[property], property)
  );
}

function presetMatches(patch, locals) {
  const keys = ownKeys(patch);
  return keys.length > 0 && keys.every((key) => valuesMatch(patch[key], locals && locals[key]));
}

module.exports = {
  DANGEROUS_KEYS,
  FONT_PATCH_PROPS,
  isPlainObject,
  ownKeys,
  isSafePresetKey,
  normalizeColor,
  numericValue,
  presetMatches,
};
