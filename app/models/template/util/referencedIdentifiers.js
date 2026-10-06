var mustache = require("mustache");

// Every identifier a view and its partials mention anywhere, e.g. {{#a.b}} and
// {{{c}}} give a, b and c - whatever context they would resolve in. This is
// coarse by design: it can say a template names something it never reaches,
// never the reverse, so callers can use it to skip work only when a name is
// absent.
//
//   has(name)  whether the bundle may reference `name`. Always true when part
//              of the bundle can't be parsed, since it could hold anything.
module.exports = function referencedIdentifiers(viewContent, allPartials) {
  var names = {};
  var unparseable = false;

  addFrom(viewContent);

  if (allPartials && typeof allPartials === "object") {
    Object.keys(allPartials).forEach(function (name) {
      addFrom(allPartials[name]);
    });
  }

  return {
    has: function (name) {
      return unparseable || names[name] === true;
    },
  };

  function addFrom(content) {
    if (!content || typeof content !== "string") return;

    var tokens;

    try {
      tokens = mustache.parse(content);
    } catch (e) {
      // A fragment that doesn't parse on its own (caller-supplied inline
      // content, entry HTML with stray braces, ...).
      unparseable = true;
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
};
