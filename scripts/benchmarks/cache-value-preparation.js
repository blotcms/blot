#!/usr/bin/env node
"use strict";

// Focused render-cache microbenchmark. Run with:
//   NODE_PATH=app node scripts/benchmarks/cache-value-preparation.js
// It intentionally includes EntryInstance values so structuredClone's lost
// prototype is visible rather than accidentally treating it as a candidate.
const { performance } = require("perf_hooks");
const EntryInstance = require("models/entry/instance");
const {
  cloneDeep,
  deepFreeze,
  prepareCacheValue,
} = require("../../app/blog/lib/clone");

const entries = Array.from({ length: 2000 }, (_, index) => {
  const entry = new EntryInstance();
  entry.id = String(index);
  entry.title = `Post ${index}`;
  entry.html = "x".repeat(4096);
  entry.tags = ["cache", "benchmark"];
  return entry;
});
const fixture = { entries, pagination: { current: 1, total: 20 } };

function measure(name, operation, iterations = 10) {
  operation();
  const start = performance.now();
  let result;
  for (let index = 0; index < iterations; index++) result = operation();
  const milliseconds = performance.now() - start;
  return { name, milliseconds: +milliseconds.toFixed(2), result };
}

const legacy = measure("cloneDeep + freeze + stringify", () => {
  const payload = deepFreeze(
    cloneDeep(fixture, { preserveEntryInstances: true }),
  );
  return { payload, size: JSON.stringify(payload).length };
});
const prepared = measure("single-walk prepareCacheValue", () =>
  prepareCacheValue(fixture, { preserveEntryInstances: true }),
);
const hit = measure("cache-hit cloneDeep", () =>
  cloneDeep(prepared.result.payload, { preserveEntryInstances: true }),
);
const native = measure("structuredClone", () => structuredClone(fixture));

console.table(
  [legacy, prepared, hit, native].map(({ name, milliseconds }) => ({
    operation: name,
    milliseconds,
  })),
);
console.log({
  preparedPreservesPrototype:
    prepared.result.payload.entries[0] instanceof EntryInstance,
  hitPreservesPrototype: hit.result.entries[0] instanceof EntryInstance,
  structuredClonePreservesPrototype:
    native.result.entries[0] instanceof EntryInstance,
});
