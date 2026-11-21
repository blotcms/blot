const EntryInstance = require("models/entry/instance");

// A shallow copy for the walks below to fill in, made so V8 keeps it in
// fast mode (#2795). Built a key at a time, an object past ~16 keys ends in
// dictionary mode: a 30-field entry then costs ~1,700 bytes instead of ~300,
// and the copies here are what the render caches hold and every hit makes.
// Spreading the source copies its shape in one go, and with __proto__ in the
// same literal an EntryInstance stays one (instanceof Entry still holds).
// Values are replaced after, in place, which adds no keys. An object with
// symbol keys, which spread would copy and Object.keys skips, is copied the
// old way so the result has exactly the same keys as before.
function emptyCopy(value, preserveEntryInstances) {
  const asEntry = preserveEntryInstances && value instanceof EntryInstance;
  if (Object.getOwnPropertySymbols(value).length)
    return asEntry ? new EntryInstance() : {};
  return asEntry
    ? { __proto__: EntryInstance.prototype, ...value }
    : { ...value };
}

function cloneDeep(value, { preserveEntryInstances = false } = {}) {
  if (Array.isArray(value)) {
    return value.map((item) => cloneDeep(item, { preserveEntryInstances }));
  }

  if (value && typeof value === "object") {
    const clone = emptyCopy(value, preserveEntryInstances);

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
//
// An object reachable from several places (e.g. one backlinked entry shared
// by every entry that links to it, see render/load/augment.js) is copied and
// counted once, and the copies point at the same frozen payload - copying it
// per reference would multiply its memory by the number of references.
function prepareCacheValue(value, { preserveEntryInstances = false } = {}) {
  const seen = new Set();
  const prepared = new Map();

  function visit(input) {
    if (typeof input === "string") {
      return { payload: input, size: Buffer.byteLength(input) || 1 };
    }
    if (!input || typeof input !== "object") {
      return { payload: input, size: 8 };
    }
    if (seen.has(input))
      throw new TypeError("Cannot prepare circular cache value");
    // Already copied (and counted) elsewhere: just a reference to it here.
    if (prepared.has(input)) return { payload: prepared.get(input), size: 8 };

    seen.add(input);
    const payload = Array.isArray(input)
      ? []
      : emptyCopy(input, preserveEntryInstances);
    let size = Array.isArray(input) ? 16 : 24;

    for (const key of Object.keys(input)) {
      const child = visit(input[key]);
      payload[key] = child.payload;
      size += child.size;
      size += Array.isArray(input) ? 8 : 16 + Buffer.byteLength(key);
    }
    seen.delete(input);
    prepared.set(input, payload);
    return { payload: Object.freeze(payload), size: Math.max(1, size) };
  }

  return Object.freeze(visit(value));
}

module.exports = { cloneDeep, deepFreeze, prepareCacheValue, emptyCopy };
