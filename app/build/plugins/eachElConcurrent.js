// For work on a post's elements that waits on the network (oEmbed lookups).
// The lookups for a post's links run concurrently, a few at a time, and their
// results are applied to the document one by one in document order, so the
// resulting HTML is the same as when the links were handled one after another.
//
// lookup(el) does the slow part and must not touch the document. It returns
// undefined to skip the element, or a result that is passed to apply(el, result).
// apply runs synchronously, in document order, after all lookups have settled.

const eachLimit = require("helper/eachLimit");

const LIMIT = 4;

module.exports = async function eachElConcurrent(
  $,
  tag,
  lookup,
  apply,
  limit = LIMIT
) {
  const elements = [];

  $(tag).each((i, el) => {
    if (el && el.name === tag) elements.push(el);
  });

  const results = await eachLimit(elements, limit, (el) => lookup(el));

  elements.forEach((el, i) => {
    if (results[i] !== undefined) apply(el, results[i]);
  });
};
