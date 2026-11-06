const clfdate = require("helper/clfdate");

// helper/withCallback for the build functions that call back with several
// results, (err, html, stat, extras): a converter's read, the single and
// multiple builders and the plugin runner. They are written as async
// functions which resolve to the array of results. Called with a function as
// its last argument, the wrapped function calls it back once, with (err) or
// (null, ...results), and returns nothing. Called without one, it returns the
// promise of the array.
//
// As in withCallback, a callback that throws is logged, not called a second
// time, and what the callback returns is ignored, so an async callback that
// rejects is still an unhandled rejection.
module.exports = function withResults(fn) {
  const name = fn.name || "anonymous";

  return function (...args) {
    const callback =
      typeof args[args.length - 1] === "function" ? args.pop() : null;

    let promise;

    try {
      promise = Promise.resolve(fn.apply(this, args));
    } catch (err) {
      promise = Promise.reject(err);
    }

    if (!callback) return promise;

    promise
      .then(
        (results) => {
          callback(null, ...results);
        },
        (err) => {
          callback(err);
        }
      )
      .catch((err) => {
        console.error(clfdate(), `withResults: ${name}'s callback threw`, err);
      });
  };
};
