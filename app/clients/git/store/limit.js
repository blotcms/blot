// Run async work with at most `limit` tasks in flight.

// Maps `items` through `fn` with at most `limit` calls running at once.
// Results are in input order. The first rejection stops starting new calls
// and is thrown once the ones already running have settled.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failure = null;

  async function worker() {
    while (!failure && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failure = failure || { err };
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i++) workers.push(worker());
  await Promise.all(workers);

  if (failure) throw failure.err;
  return results;
}

// A counting semaphore: `await acquire()` returns a `release` function.
function createSemaphore(limit) {
  let active = 0;
  const waiting = [];

  function release() {
    active--;
    const next = waiting.shift();
    if (next) next();
  }

  return async function acquire() {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    active++;
    return release;
  };
}

module.exports = { mapLimit, createSemaphore };
