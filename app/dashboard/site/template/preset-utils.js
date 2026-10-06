const tinyColor = require("../../../helper/tinyColor");

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function ownKeys(value) {
  return isPlainObject(value) ? Object.keys(value) : [];
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
  return leftColor !== null && rightColor !== null && leftColor === rightColor;
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
  isPlainObject,
  ownKeys,
  normalizeColor,
  numericValue,
  presetMatches,
};
