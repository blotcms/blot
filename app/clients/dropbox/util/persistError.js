const database = require("../database");
const { classify } = require("./classifyError");

// Persist a Dropbox error onto the blog's account row when it is
// user-actionable. Transient failures are ignored so a previous durable
// error (e.g. 401) is not overwritten by a later 500, and a healthy
// account is not marked broken by a blip.
module.exports = function persistError(blogID, err, source, callback) {
  if (err && err.name === "AbortError") return callback(null);

  const classified = classify(err, (err && err.dropboxSource) || source);
  if (!classified.persist) return callback(null);

  database.setError(blogID, classified, callback);
};
