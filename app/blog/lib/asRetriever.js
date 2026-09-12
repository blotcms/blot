// Wrap a retriever so it supports both:
//   await retriever(req, res)
//   retriever(req, res, (err, value) => ...)
//
// Sync retrievers that return a value immediately invoke the callback
// synchronously (important for unit tests that read the callback result
// on the same tick). Async retrievers that return a Promise settle via
// that Promise.
module.exports = function asRetriever(fn) {
  return function (req, res, callback) {
    let result;

    try {
      result = fn(req, res);
    } catch (err) {
      if (typeof callback === "function") {
        callback(err);
        return;
      }
      return Promise.reject(err);
    }

    if (result && typeof result.then === "function") {
      if (typeof callback === "function") {
        result.then((value) => callback(null, value), callback);
        return;
      }
      return result;
    }

    if (typeof callback === "function") {
      callback(null, result);
      return;
    }

    return Promise.resolve(result);
  };
};
