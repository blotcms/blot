// Runs iteratee(item, index) over items with at most `limit` running at once,
// in the order of items, like async.eachLimit / mapLimit. Resolves to the
// results in item order. After the first rejection no new item is started,
// and the returned promise rejects with that error straight away; items
// already running are left to finish.
module.exports = async function eachLimit(items, limit, iteratee) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;

  async function worker() {
    while (!failed && next < items.length) {
      const index = next++;

      try {
        results[index] = await iteratee(items[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }

  const workers = [];

  for (let i = 0; i < Math.min(limit, items.length); i++)
    workers.push(worker());

  await Promise.all(workers);

  return results;
};
