var mustache = require("mustache");
var type = require("helper/type");
var projectableEntryFields = require("./projectableEntryFields");

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

  var referenced = collectReferencedIdentifiers(viewContent, allPartials);

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
      if (!value.fields[field] && referenced[field]) {
        value.fields[field] = true;
      }
    });
  });

  return retrieve;
};

function collectReferencedIdentifiers(viewContent, allPartials) {
  var names = {};

  addFrom(viewContent);

  if (allPartials && typeof allPartials === "object") {
    Object.keys(allPartials).forEach(function (name) {
      addFrom(allPartials[name]);
    });
  }

  return names;

  function addFrom(content) {
    if (!content || typeof content !== "string") return;

    var tokens;

    try {
      tokens = mustache.parse(content);
    } catch (e) {
      // A fragment that doesn't parse on its own (caller-supplied inline
      // content, entry HTML with stray braces, ...). Be safe: treat every
      // heavy field as referenced.
      projectableEntryFields.forEach(function (field) {
        names[field] = true;
      });
      return;
    }

    walk(tokens);
  }

  function walk(tokens) {
    if (!Array.isArray(tokens)) return;

    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      var tokenType = token && token[0];

      if (
        tokenType === "name" ||
        tokenType === "&" ||
        tokenType === "#" ||
        tokenType === "^"
      ) {
        String(token[1])
          .split(".")
          .forEach(function (segment) {
            if (segment) names[segment] = true;
          });
      }

      if (Array.isArray(token[4])) walk(token[4]);
    }
  }
}
