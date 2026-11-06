const clfdate = require("helper/clfdate");

// Lets a function that has been converted to async keep serving callers that
// still pass a callback, while the callers move to promises (#2559). Called
// with a function as its last argument, the wrapped function calls it back
// once, with (err) or (null, result), and returns nothing. Called without
// one, it returns the promise.
//
// A callback that throws is logged, not called a second time, and not
// rethrown: the process exits on an unhandled rejection (app/index.js), and
// a second call with the callback's own error was the double-callback bug
// this replaces. What the callback returns is ignored, so an async callback
// that rejects is still an unhandled rejection, as it was before.
module.exports = function withCallback(fn) {
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
        (result) => {
          callback(null, result);
        },
        (err) => {
          callback(err);
        }
      )
      .catch((err) => {
        console.error(clfdate(), `withCallback: ${name}'s callback threw`, err);
      });
  };
};
