var makeID = require("./makeID");

// A template is resolved everywhere by its id. writeToFolder names a locally
// edited template's on-disk directory after its stored slug and readFromFolder
// turns that name back into an id with makeID, so a slug which makeID maps to a
// *different* id lets the template be read back as another template and
// overwrite it (see models/template/create.js and readFromFolder.js).
//
// Return the id's own suffix — the slug that follows the name rather than one a
// caller invented. Callers that build a template should use this instead of a
// hand-made slug which may not survive makeID's 30-character truncation.
//
// makeID is not perfectly idempotent for names whose slug contains percent-
// encoded bytes (a non-ASCII name), so the suffix is not guaranteed to map
// straight back to the id in that case. That is a pre-existing makeID quirk
// which also affects editor routing; this helper does not try to paper over it.
module.exports = function slugForName(owner, name) {
  return makeID(owner, name).split(":").slice(1).join(":");
};
