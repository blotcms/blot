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
module.exports = function hardenProjectedRetrieve(retrieve, viewContent, allPartials, viewLocals) {
  if (!retrieve || typeof retrieve !== "object") return retrieve;

  var referenced = collectReferencedIdentifiers(viewContent, allPartials, viewLocals);

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

function collectReferencedIdentifiers(viewContent, allPartials, viewLocals) {
  var names = {};

  addFrom(viewContent);

  if (allPartials && typeof allPartials === "object") {
    Object.keys(allPartials).forEach(function (name) {
      addFrom(allPartials[name]);
    });
  }

  // Locals can hold mustache that renderLocals evaluates later - a heavy field
  // referenced only from a string local (e.g. locals.snippet = "{{{html}}}")
  // must be kept too. renderLocals recurses without a depth limit, so match
  // that: walk arbitrarily deep, guarding only against cycles.
  addFromValue(viewLocals, new WeakSet());

  return names;

  function addFromValue(value, seen) {
    if (value == null) return;
    if (typeof value === "string") return addFrom(value);
    if (typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) addFromValue(value[i], seen);
      return;
    }

    Object.keys(value).forEach(function (key) {
      addFromValue(value[key], seen);
    });
  }

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
