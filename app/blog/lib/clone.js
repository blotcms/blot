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

module.exports = { cloneDeep, deepFreeze };
