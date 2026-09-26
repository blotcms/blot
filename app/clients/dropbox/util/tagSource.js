// Marks an error with the sync step that produced it so persistError can
// classify it correctly when it surfaces far from where it was thrown,
// e.g. from a long resync. The first tag wins.
module.exports = function tagSource(source, promise) {
  return promise.catch(function (err) {
    if (err && typeof err === "object" && !err.dropboxSource) {
      err.dropboxSource = source;
    }
    throw err;
  });
};
