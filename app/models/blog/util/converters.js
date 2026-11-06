const VALID_CONVERTER_IDS = [
  "html",
  "img",
  "webloc",
  "gdoc",
  "docx",
  "rtf",
  "odt",
  "org",
  "markdown",
];

const DEFAULTS = VALID_CONVERTER_IDS.reduce(function (acc, id) {
  acc[id] = true;
  return acc;
}, {});

function normalizeBoolean(value, fallback) {
  if (typeof value === "boolean") return value;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();

    if (["true", "1", "yes", "on", "enabled"].indexOf(normalized) > -1)
      return true;

    if (["false", "0", "no", "off", "disabled", ""].indexOf(normalized) > -1)
      return false;
  }

  return fallback;
}

function normalize(raw, options = {}) {
  const fallback = normalizeFallback(options.fallback);

  if (typeof raw === "boolean") {
    return makeAll(raw);
  }

  if (!raw || typeof raw !== "object") {
    return fallback;
  }

  const normalized = Object.assign({}, fallback);

  for (const id of VALID_CONVERTER_IDS) {
    if (Object.prototype.hasOwnProperty.call(raw, id)) {
      normalized[id] = normalizeBoolean(raw[id], fallback[id]);
    }
  }

  return normalized;
}

function normalizeFallback(rawFallback) {
  if (!rawFallback || typeof rawFallback !== "object") {
    if (typeof rawFallback === "boolean") return makeAll(rawFallback);
    return Object.assign({}, DEFAULTS);
  }

  const normalizedFallback = Object.assign({}, DEFAULTS);

  for (const id of VALID_CONVERTER_IDS) {
    if (!Object.prototype.hasOwnProperty.call(rawFallback, id)) continue;

    normalizedFallback[id] = normalizeBoolean(rawFallback[id], DEFAULTS[id]);
  }

  return normalizedFallback;
}

function makeAll(enabled) {
  const values = {};

  for (const id of VALID_CONVERTER_IDS) values[id] = !!enabled;

  return values;
}

function apply(blog, options) {
  const normalized = normalize(blog && blog.converters, options);

  blog.converters = normalized;

  for (const id of VALID_CONVERTER_IDS) {
    const helper =
      "is" + id.charAt(0).toUpperCase() + id.slice(1) + "ConverterEnabled";
    blog[helper] = normalized[id] === true;
  }

  return blog;
}

module.exports = {
  VALID_CONVERTER_IDS,
  DEFAULTS,
  normalize,
  apply,
};
