var type = require("helper/type");
var projectableEntryFields = require("./projectableEntryFields");
var referencedIdentifiers = require("./referencedIdentifiers");

// Field projection (blog/render/retrieve/helpers/projectEntryFields.js) drops
// the heavy entry fields a view does not reference. Working that out from
// nested template context is fragile - entry lists resolved through outer
// sections, partials reached in a new context, numeric list indexes, custom
// delimiters, ... all have ways of hiding a real reference.
//
// This is the coarse, hard-to-get-wrong backstop: re-derive every identifier
// referenced ANYWHERE in the fully assembled template bundle (the view plus
// every partial's content) and make sure no heavy field that appears there is
// ever projected away. Over-broad (an {{{html}}} outside any entry loop keeps
// `html` on every entry local) but only ever keeps fields, never drops one.
//
// String locals are not templates: the render pipeline treats them as data
// (see blog/render/middleware.js), so a local like snippet = "{{{html}}}" is
// not a reason to keep `html`.
module.exports = function hardenProjectedRetrieve(retrieve, viewContent, allPartials) {
  if (!retrieve || typeof retrieve !== "object") return retrieve;

  var referenced = referencedIdentifiers(viewContent, allPartials);

  Object.keys(retrieve).forEach(function (key) {
    var value = retrieve[key];

    // Only { fields: {...} } projection metadata is affected. A boolean (or
    // anything else) already means "don't project", leave it alone.
    if (
      !value ||
      type(value, "array") ||
      typeof value !== "object" ||
      !value.fields ||
      typeof value.fields !== "object"
    ) {
      return;
    }

    projectableEntryFields.forEach(function (field) {
      if (!value.fields[field] && referenced.has(field)) {
        value.fields[field] = true;
      }
    });
  });

  return retrieve;
};
