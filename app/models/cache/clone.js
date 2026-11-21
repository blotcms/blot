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
//
// An object reachable from several places (e.g. one backlinked entry shared
// by every entry that links to it, see render/load/augment.js) is copied and
// counted once, and the copies point at the same frozen payload - copying it
// per reference would multiply its memory by the number of references.
//
// heapBytes is a second, V8-shaped estimate kept beside size, to account for
// node-a's heap (#2795): there the heap has tracked about 1.75 times the
// render caches' summed size. It only reports; caps still use size. A string
// costs a 16-byte header plus one byte per character, or two once it holds a
// character above U+00FF (V8 then stores the whole string as UTF-16), and
// twoByteBytes counts those. Keys cost nothing (V8 shares them through the
// object's map), an object costs its header, in-object slack and property
// array, an array its header and element store, and a number that isn't a
// small integer a 16-byte box. An object given more than about 20 keys one
// at a time, as the copy below is, goes to V8's dictionary mode: a hash
// table of three slots per entry at twice the key count, rounded up to a
// power of two (an entry's ~30 fields cost ~1.6 KB rather than ~300 bytes). A string sliced from a larger one keeps the
// larger one alive, which nothing in JavaScript can see: whatever of the heap
// heapBytes still misses is that, or something outside the caches.
const STRING_HEADER = 16;
const OBJECT_BYTES = 56;
const ARRAY_BYTES = 48;
const SLOT_BYTES = 8;
const HEAP_NUMBER_BYTES = 16;
const DICTIONARY_KEYS = 20;
const DICTIONARY_BYTES = 96;
const DICTIONARY_SLOT_BYTES = 24;
const TWO_BYTE = /[\u0100-\uffff]/;

function align(bytes) {
  return Math.ceil(bytes / 8) * 8;
}

function dictionaryBytes(keys) {
  let capacity = 1;
  while (capacity < keys * 2) capacity *= 2;
  return DICTIONARY_BYTES + capacity * DICTIONARY_SLOT_BYTES;
}

function prepareCacheValue(value, { preserveEntryInstances = false } = {}) {
  const seen = new Set();
  const prepared = new Map();
  let twoByteBytes = 0;

  function visit(input) {
    if (typeof input === "string") {
      const twoByte = TWO_BYTE.test(input);
      const chars = align(input.length * (twoByte ? 2 : 1));
      if (twoByte) twoByteBytes += chars;
      return {
        payload: input,
        size: Buffer.byteLength(input) || 1,
        heap: STRING_HEADER + chars,
      };
    }
    if (typeof input === "number") {
      const small = Number.isInteger(input) && Math.abs(input) < 2 ** 31;
      return { payload: input, size: 8, heap: small ? 0 : HEAP_NUMBER_BYTES };
    }
    if (!input || typeof input !== "object") {
      return { payload: input, size: 8, heap: 0 };
    }
    if (seen.has(input))
      throw new TypeError("Cannot prepare circular cache value");
    // Already copied (and counted) elsewhere: just a reference to it here.
    if (prepared.has(input))
      return { payload: prepared.get(input), size: 8, heap: 0 };

    seen.add(input);
    const payload = Array.isArray(input)
      ? []
      : preserveEntryInstances && input instanceof EntryInstance
        ? new EntryInstance()
        : {};
    let size = Array.isArray(input) ? 16 : 24;
    let heap = Array.isArray(input) ? ARRAY_BYTES : OBJECT_BYTES;

    const keys = Object.keys(input);
    for (const key of keys) {
      const child = visit(input[key]);
      payload[key] = child.payload;
      size += child.size;
      size += Array.isArray(input) ? 8 : 16 + Buffer.byteLength(key);
      heap += child.heap + SLOT_BYTES;
    }
    if (!Array.isArray(input) && keys.length >= DICTIONARY_KEYS)
      heap +=
        dictionaryBytes(keys.length) - OBJECT_BYTES - keys.length * SLOT_BYTES;
    seen.delete(input);
    prepared.set(input, payload);
    return {
      payload: Object.freeze(payload),
      size: Math.max(1, size),
      heap,
    };
  }

  const { payload, size, heap } = visit(value);
  return Object.freeze({ payload, size, heapBytes: heap, twoByteBytes });
}

module.exports = { cloneDeep, deepFreeze, prepareCacheValue };
