const VALID_MODES = ["off", "basic", "full"];
const DEFAULT_ON_MODE = "basic";
const DEFAULT_OFF_MODE = "off";

function extractModeFromObject(raw) {
  if (!raw || typeof raw !== "object") return undefined;

  let mode =
    typeof raw.mode === "string" ? raw.mode.trim().toLowerCase() : undefined;

  if (mode === "") mode = undefined;

  if (mode && !VALID_MODES.includes(mode)) mode = undefined;

  if (raw.enabled === false) return DEFAULT_OFF_MODE;

  if (raw.enabled === true) {
    if (!mode || mode === "off") return DEFAULT_ON_MODE;
    return mode;
  }

  return mode;
}

function resolveFallback(options = {}) {
  if (typeof options.fallback === "string") {
    const fallback = options.fallback.trim().toLowerCase();
    if (VALID_MODES.includes(fallback)) return fallback;
    if (fallback === "") return DEFAULT_OFF_MODE;
  }

  const fromObject = extractModeFromObject(options.fallback);
  if (fromObject) return fromObject;

  if (typeof options.fallbackEnabled === "boolean") {
    return options.fallbackEnabled ? DEFAULT_ON_MODE : DEFAULT_OFF_MODE;
  }

  return DEFAULT_OFF_MODE;
}

function normalize(raw, options = {}) {
  const fallback = resolveFallback(options);

  if (typeof raw === "string") {
    const value = raw.trim().toLowerCase();
    if (!value) return DEFAULT_OFF_MODE;
    if (VALID_MODES.includes(value)) return value;
    if (value === "on") return DEFAULT_ON_MODE;
    return fallback;
  }

  const objectMode = extractModeFromObject(raw);
  if (objectMode) return objectMode;

  return fallback;
}

function decorate(raw, options) {
  const mode = normalize(raw, options);

  return {
    mode,
    isOff: mode === "off",
    isBasic: mode === "basic",
    isFull: mode === "full",
  };
}

function apply(blog, options) {
  const decorated = decorate(blog && blog.imageExif, options);
  blog.imageExif = decorated.mode;
  blog.imageExifMode = decorated.mode;
  blog.isImageExifOff = decorated.isOff;
  blog.isImageExifBasic = decorated.isBasic;
  blog.isImageExifFull = decorated.isFull;
  return blog;
}

module.exports = {
  normalize,
  decorate,
  apply,
  VALID_MODES,
};
