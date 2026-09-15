const EntryInstance = require("models/entry/instance");

function cloneDeep(value, { preserveEntryInstances = false } = {}) {
  if (Array.isArray(value)) {
    return value.map((item) => cloneDeep(item, { preserveEntryInstances }));
  }

  if (value && typeof value === "object") {
    const clone =
      preserveEntryInstances && value instanceof EntryInstance
        ? new EntryInstance()
        : {};

    Object.keys(value).forEach((key) => {
      clone[key] = cloneDeep(value[key], { preserveEntryInstances });
    });

    return clone;
  }

  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  Object.keys(value).forEach((key) => {
    deepFreeze(value[key]);
  });

  return Object.freeze(value);
}

// Clone, freeze and measure a value in one walk for insertion into an LRU.
// The estimate describes retained JavaScript data rather than a temporary
// serialization: strings and enumerable object keys contribute their UTF-8
// byte length; arrays contribute 8 bytes per element; objects contribute 16
// bytes per enumerable property; and primitives contribute 8 bytes.
// Supported containers are arrays and enumerable objects (the same domain as
// cloneDeep); EntryInstance objects use the object rules and retain their
// prototype when requested.
// Container/property overhead is deliberately included so maxSize remains a
// conservative memory bound. Circular values are unsupported, just as they
// are by the JSON based size calculation this replaces.
function prepareCacheValue(value, { preserveEntryInstances = false } = {}) {
  const seen = new Set();

  function visit(input) {
    if (typeof input === "string") {
      return { payload: input, size: Buffer.byteLength(input) || 1 };
    }
    if (!input || typeof input !== "object") {
      return { payload: input, size: 8 };
    }
    if (seen.has(input))
      throw new TypeError("Cannot prepare circular cache value");

    seen.add(input);
    const payload = Array.isArray(input)
      ? []
      : preserveEntryInstances && input instanceof EntryInstance
        ? new EntryInstance()
        : {};
    let size = Array.isArray(input) ? 16 : 24;

    for (const key of Object.keys(input)) {
      const child = visit(input[key]);
      payload[key] = child.payload;
      size += child.size;
      size += Array.isArray(input) ? 8 : 16 + Buffer.byteLength(key);
    }
    seen.delete(input);
    return { payload: Object.freeze(payload), size: Math.max(1, size) };
  }

  const prepared = visit(value);
  return Object.freeze(prepared);
}

module.exports = { cloneDeep, deepFreeze, prepareCacheValue };
