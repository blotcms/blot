const { classify } = require("./classifyError");

// Persist a Dropbox error onto the blog's account row when it is
// user-actionable. Transient failures are ignored so a previous durable
// error (e.g. 401) is not overwritten by a later 500, and a healthy
// account is not marked broken by a blip.
async function persistError(blogID, err, source) {
  if (err && err.name === "AbortError") return;

  const classified = classify(err, (err && err.dropboxSource) || source);
  if (!classified.persist) return;

  // Required here, not at the top: ../database requires models/blog, which
  // can load this module before ../database has assigned its exports, and a
  // top-level require would then keep the empty placeholder object.
  return require("../database").setError(blogID, classified);
}

module.exports = persistError;
