"use strict";

/**
 * Run `worker` over `items` with at most `limit` concurrent invocations.
 * Uses a shared cursor rather than Array#shift so the queue drain is O(n)
 * even for the large (thousands of files) workloads the benchmark generates.
 */
async function runWithConcurrency(items, limit, worker) {
  const size = Math.max(1, Math.floor(limit));
  let cursor = 0;

  async function drain() {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  }

  const workers = [];
  for (let i = 0; i < size; i++) {
    workers.push(drain());
  }

  await Promise.all(workers);
}

module.exports = {
  runWithConcurrency,
};
