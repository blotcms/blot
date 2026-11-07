// Wrap a retriever (a sync or async function of (req, res)) so that calling it
// always returns a promise: a value it returns resolves, and an error it
// throws rejects.
module.exports = function asRetriever(fn) {
  return async function (req, res) {
    return fn(req, res);
  };
};
