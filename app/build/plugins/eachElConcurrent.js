// Like eachEl, but for work that waits on the network (oEmbed lookups). The
// lookups for a post's links run concurrently, a few at a time, and their
// results are applied to the document one by one in document order, so the
// resulting HTML is the same as when the links were handled one after another.
//
// lookup(el) does the slow part and must not touch the document. It returns
// undefined to skip the element, or a result that is passed to apply(el, result).
// apply runs synchronously, in document order, after all lookups have settled.

const LIMIT = 4;

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );

  return results;
}

async function eachElConcurrent($, tag, lookup, apply, limit = LIMIT) {
  const elements = [];

  $(tag).each((i, el) => {
    if (el && el.name === tag) elements.push(el);
  });

  const results = await mapLimit(elements, limit, (el) => lookup(el));

  elements.forEach((el, i) => {
    if (results[i] !== undefined) apply(el, results[i]);
  });
}

module.exports = eachElConcurrent;
module.exports.mapLimit = mapLimit;
module.exports.LIMIT = LIMIT;
