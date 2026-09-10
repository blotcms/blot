var _ = require("lodash");
var mustache = require("mustache");
var type = require("helper/type");
var projectableEntryFields = require("./util/projectableEntryFields");

// Heavy entry fields keyed for O(1) lookup. Referenced anywhere inside an
// entry-list context - including through ordinary predicate sections like
// {{#first}} where Mustache still resolves them from the parent entry - they
// must be recorded so retrieve-time projection never drops them.
var heavyEntryFieldSet = {};
projectableEntryFields.forEach(function (name) {
  heavyEntryFieldSet[name] = true;
});

// My goal is to look at a template
// retrieve a list of variables and partials inside the template
// find those variables which I am allowed to fetch

// and store the relevant method and arguments
// neccessary to retrieve those at run time...

var modules = require("fs").readdirSync(
  __dirname + "/../../blog/render/retrieve"
);

// Build a list of locals which blot will fetch
// returns a list like this:
// ['allEntries', 'recentEntries', 'allTags', 'archives', 'updated', 'appCSS', 'appJS', 'public']
var retrieveThese = _.filter(modules, function (name) {
  return name.charAt(0) !== "." && name !== "index.js";
})
  .map(function (name) {
    return name.slice(0, name.lastIndexOf("."));
  })
  .sort();

var projectedEntryLocals = {
  allEntries: [""],
  all_entries: [""],
  recentEntries: [""],
  recent_entries: [""],
  latestEntry: [""],
  latest_entry: [""],
  posts: [""],
  search_results: [""],
  tagged: ["entries"],
  archives: ["months.entries"],
};

// Section helpers that transform the text they wrap but keep the surrounding
// data context. e.g. {{#encode_xml}}{{{body}}}{{/encode_xml}} inside an entry
// list still references the entry's `body`, so field projection has to see
// through them. Without this, feeds that wrap {{{body}}}/{{{html}}} in an
// encoder would have those fields projected away at retrieve time.
var transparentSectionHelpers = {
  encode_xml: true,
  encodeXML: true,
  encode_json: true,
  encodeJSON: true,
  encode_uri_component: true,
  encodeURIComponent: true,
  absolute_urls: true,
  absoluteURLs: true,
  formatDate: true,
  formatUpdated: true,
  formatCreated: true,
};

// blog/render/retrieve/index.js exposes each retrieve module under aliases
// that are not derivable from its filename (appCSS for app_css.js, encodeXML
// for encode_xml.js, ...). These have no file of their own, so list them here.
// tests/systemRetrieveLocals.js asserts this stays in sync with the dictionary.
var retrieveAliases = {
  absoluteURLs: true,
  allTags: true,
  appCSS: true,
  appJS: true,
  encodeJSON: true,
  encodeURIComponent: true,
  encodeXML: true,
  isActive: true,
  plugin_css: true,
  plugin_js: true,
};

function isProjectedEntryLocal(name) {
  return !!projectedEntryLocals[name];
}

function isSystemRetrieveLocal(name) {
  return (
    retrieveThese.indexOf(name) > -1 ||
    isProjectedEntryLocal(name) ||
    retrieveAliases[name] === true
  );
}

function parseTemplate(template) {
  var retrieve = {};
  var partials = {};
  var parsed;

  try {
    parsed = mustache.parse(template);
  } catch (e) {
    return { partials: partials, retrieve: retrieve };
  }

  var projectedFieldContexts = {};

  // Context paths discovered at parse time whose direct leaf variables are
  // entry fields of the named projected-entry local - currently only the
  // synthetic contexts created when we descend through a transparent section
  // helper such as {{#encode_xml}}. Static entry-list contexts are matched
  // structurally by entryRootForContext() instead.
  var entryFieldContexts = {};

  // Flat context path -> array of the section-token names that produced it.
  // A single dotted section ({{#author.posts}}) is one segment "author.posts";
  // nested sections ({{#show}}{{#posts}}) are two segments ["show", "posts"].
  // entryRootForContext() uses this so its tail match only fires on whole
  // section boundaries - {{#author.posts}} must NOT be read as the root
  // `posts` entry list.
  var contextSegments = { "": [] };

  process("", parsed);

  // Return the projected-entry-local root if `contextPath` ends at one of its
  // field contexts (e.g. "allEntries", "show.posts", "a.b.tagged.entries" all
  // map to their root). Matching the tail rather than a seeded exact path
  // means an entry list resolved from the root through an outer section is
  // still recognised.
  function entryRootForContext(contextPath) {
    if (!contextPath) return null;

    if (entryFieldContexts[contextPath]) return entryFieldContexts[contextPath];

    var segments = contextSegments[contextPath];

    for (var root in projectedEntryLocals) {
      var prefixes = projectedEntryLocals[root] || [];
      for (var i = 0; i < prefixes.length; i++) {
        var pattern = prefixes[i] ? root + "." + prefixes[i] : root;

        if (contextPath === pattern) return root;

        if (segments) {
          // Only match when `pattern` lines up with whole section-token
          // boundaries, so {{#author.posts}} (one segment) is not mistaken
          // for the root `posts` list while {{#show}}{{#posts}} still is.
          for (var s = 1; s < segments.length; s++) {
            if (segments.slice(s).join(".") === pattern) return root;
          }
        } else if (contextPath.slice(-(pattern.length + 1)) === "." + pattern) {
          // No segment info (synthetic path) - fall back to the string tail.
          return root;
        }
      }
    }

    return null;
  }

  // Helper function to set nested property in retrieve object
  // Converts boolean values to objects when needed
  function setNestedProperty(root, propertyPath, value) {
    if (!retrieve[root]) {
      retrieve[root] = {};
    } else if (retrieve[root] === true) {
      // Convert boolean to object if we're adding nested properties
      retrieve[root] = {};
    }

    var parts = propertyPath.split(".");
    var current = retrieve[root];
    
    for (var i = 0; i < parts.length - 1; i++) {
      var part = parts[i];
      if (!current[part] || current[part] === true) {
        current[part] = {};
      }
      current = current[part];
    }
    
    current[parts[parts.length - 1]] = value;
  }

  function setProjectedEntryField(root, fieldName) {
    if (!projectedEntryLocals[root]) return false;
    if (!isProjectableEntryFieldName(fieldName)) return false;

    setNestedProperty(root, "fields." + fieldName, true);
    return true;
  }

  function projectedFieldFromContext(contextPath, variableName) {
    if (!contextPath || !variableName) return null;

    var fieldName =
      variableName.indexOf(".") > -1
        ? variableName.slice(0, variableName.indexOf("."))
        : variableName;

    if (!fieldName) return null;

    var root = entryRootForContext(contextPath);
    if (root) return { root: root, field: fieldName };

    return null;
  }

  // Walk up a context path to the closest ancestor that is an entry-field
  // context, returning its projected-entry-local root. Lets a heavy field
  // buried under ordinary predicate sections (e.g. posts > first > html) still
  // be attributed to the entry.
  function nearestEntryFieldRoot(contextPath) {
    var current = contextPath;

    while (current) {
      var root = entryRootForContext(current);
      if (root) return root;
      var lastDot = current.lastIndexOf(".");
      current = lastDot > -1 ? current.slice(0, lastDot) : "";
    }

    return null;
  }

  function isProjectedPathSegment(contextPath, variableName) {
    if (!contextPath || !variableName || variableName.indexOf(".") > -1) return false;

    for (var root in projectedEntryLocals) {
      var prefixes = projectedEntryLocals[root] || [];
      for (var i = 0; i < prefixes.length; i++) {
        var prefix = prefixes[i];
        if (!prefix) continue;

        var parts = prefix.split(".");
        for (var depth = 0; depth < parts.length; depth++) {
          var currentPath = depth === 0 ? root : root + "." + parts.slice(0, depth).join(".");
          if (contextPath === currentPath && variableName === parts[depth]) {
            return true;
          }
        }
      }
    }

    return false;
  }

  function isProjectedEntryPath(root, propertyPath) {
    if (!projectedEntryLocals[root] || !propertyPath) return false;

    var prefixes = projectedEntryLocals[root] || [];

    for (var i = 0; i < prefixes.length; i++) {
      if (prefixes[i] === propertyPath) return true;
    }

    return false;
  }

  function projectedFieldFromPropertyAccess(root, propertyPath) {
    if (!projectedEntryLocals[root] || !propertyPath) return null;

    var prefixes = projectedEntryLocals[root] || [];

    for (var i = 0; i < prefixes.length; i++) {
      var prefix = prefixes[i];

      if (!prefix) {
        if (isProjectableEntryFieldName(propertyPath)) return propertyPath;
        continue;
      }

      if (propertyPath.indexOf(prefix + ".") !== 0) continue;

      var fieldName = propertyPath.slice((prefix + ".").length);
      if (isProjectableEntryFieldName(fieldName)) return fieldName;
    }

    return null;
  }

  // This can be used to recursively
  // strip locals and partials we need
  // to fetch from the db before rendering
  // the temaplate
  function process(context, list) {
    if (context) context = context + ".";

    for (var i in list) {
      var token = list[i];

      if (token[0] === "#" && token[1] === "cdn") {
        // Initialize retrieve.cdn as array if it doesn't exist
        if (!retrieve.cdn || !Array.isArray(retrieve.cdn)) {
          retrieve.cdn = [];
        }
        collectCdnTargets(token[4]);
        if (type(token[4], "array")) process(context, token[4]);
        continue;
      }

      // Is a partial
      if (token[0] === ">") {
        // this is dangerous but used to avoid fetching partials twice
        partials[token[1]] = null;
      }

      // Is a variable, '#' starts iterative blocks
      // '&' starts unescaped blocks
      if (
        token[0] === "name" ||
        token[0] === "#" ||
        token[0] === "^" ||
        token[0] === "&"
      ) {
        // e.g. all_entries.length
        var variable = token[1];
        // e.g. all_entries
        var variableRoot =
          variable.indexOf(".") > -1 &&
          variable.slice(0, variable.indexOf("."));
        // e.g. length (or subfolder.property for deeper nesting)
        var propertyPath = variable.indexOf(".") > -1 &&
          variable.slice(variable.indexOf(".") + 1);
        var contextPath = context ? context.slice(0, -1) : "";
        var projectedFieldContext = projectedFieldFromContext(contextPath, variable);
        var inProjectedFieldContext = hasProjectedFieldContextAncestor(contextPath);
        var suppressAsProjectedFieldReference = false;
        var isProjectedFieldInContext = false;

        // {{#encode_xml}} & friends: descend without recording the helper name
        // as an entry field, but keep the entry context for inner variables.
        var transparentHelperEntryRoot =
          (token[0] === "#" || token[0] === "^") &&
          transparentSectionHelpers[variable]
            ? entryRootForContext(contextPath)
            : null;

        if (transparentHelperEntryRoot) {
          entryFieldContexts[contextPath + "." + variable] =
            transparentHelperEntryRoot;
          isProjectedFieldInContext = true;
        } else if (
          projectedFieldContext &&
          isLikelyProjectedEntryField(projectedFieldContext.field)
        ) {
          isProjectedFieldInContext = setProjectedEntryField(
            projectedFieldContext.root,
            projectedFieldContext.field
          );
        }

        // A heavy field referenced under an ordinary predicate section (e.g.
        // {{#posts}}{{#first}}{{{html}}}{{/first}}{{/posts}}) still resolves
        // from the parent entry at render time. Attribute it to that entry so
        // projection keeps it, even though `first` is not a real sub-object.
        var heavyFieldName = variableRoot || variable;
        if (
          !projectedFieldContext &&
          inProjectedFieldContext &&
          heavyEntryFieldSet[heavyFieldName]
        ) {
          var heavyFieldRoot = nearestEntryFieldRoot(contextPath);
          if (heavyFieldRoot) {
            setProjectedEntryField(heavyFieldRoot, heavyFieldName);
          }
        }

        if (isSystemRetrieveLocal(variable)) {
          // Special case: 'cdn' should always be an array (empty for literals, with targets for blocks)
          // to prevent soft merge issues with multiple partials via helper/extend.js
          if (variable === "cdn") {
            if (!retrieve.cdn || !Array.isArray(retrieve.cdn)) {
              retrieve.cdn = [];
            }
          } else {
            if (projectedEntryLocals[variable]) {
              retrieve[variable] = retrieve[variable] && retrieve[variable] !== true
                ? retrieve[variable]
                : {};
            } else {
              // If variable has no dots, it's a root variable - set as boolean
              // If it has dots, it's a nested property - build nested structure
              if (!propertyPath) {
                retrieve[variable] = true;
              } else {
                // This shouldn't happen for whitelisted variables with dots,
                // but handle it just in case
                retrieve[variable] = true;
              }
            }
          }
        }

        if (isSystemRetrieveLocal(variableRoot) && propertyPath) {
          // Special case: 'cdn' should always be an array (empty for literals, with targets for blocks)
          // to prevent soft merge issues with multiple partials via helper/extend.js
          if (variableRoot === "cdn") {
            if (!retrieve.cdn || !Array.isArray(retrieve.cdn)) {
              retrieve.cdn = [];
            }
          } else {
            var projectedField = projectedFieldFromPropertyAccess(
              variableRoot,
              propertyPath
            );

            if (projectedField) {
              setNestedProperty(variableRoot, "fields." + projectedField, true);
            } else if (isProjectedEntryPath(variableRoot, propertyPath)) {
              retrieve[variableRoot] = retrieve[variableRoot] && retrieve[variableRoot] !== true
                ? retrieve[variableRoot]
                : {};
            } else {
              // Build nested structure for whitelisted root with property access
              setNestedProperty(variableRoot, propertyPath, true);
            }
          }
        } else if (isSystemRetrieveLocal(variableRoot) && !propertyPath) {
          // Root variable without property access - set as boolean if not already an object
          if (variableRoot === "cdn") {
            if (!retrieve.cdn || !Array.isArray(retrieve.cdn)) {
              retrieve.cdn = [];
            }
          } else {
            // Only set as boolean if it's not already an object (from previous nested access)
            if (!retrieve[variableRoot] || retrieve[variableRoot] === true) {
              retrieve[variableRoot] = true;
            }
          }
        }

        // Track all referenced locals (including custom ones) for signature hashing
        // System locals are already tracked above, so only track non-system locals here
        // The retrieve system will safely ignore non-system locals during fetching
        // Skip tracking if variable has dots and root is whitelisted (already handled with nested structure)
        suppressAsProjectedFieldReference =
          (token[0] === "#" || token[0] === "^") && isProjectedFieldInContext;

        if (
          isProjectedFieldInContext &&
          projectedFieldContext &&
          isLowercaseProjectedEntryField(projectedFieldContext.field)
        ) {
          suppressAsProjectedFieldReference = true;
        }

        if (
          inProjectedFieldContext &&
          (isLowercaseProjectedEntryField(variable) ||
            heavyEntryFieldSet[heavyFieldName])
        ) {
          suppressAsProjectedFieldReference = true;
        }

        if (
          retrieveThese.indexOf(variable) === -1 &&
          variable !== "cdn" &&
          !isProjectedPathSegment(contextPath, variable) &&
          !suppressAsProjectedFieldReference
        ) {
          // Only track the root variable, not nested properties
          // If variable has dots and root is whitelisted, skip (already handled above)
          if (!propertyPath || !isSystemRetrieveLocal(variableRoot)) {
            if (!retrieve[variable]) {
              retrieve[variable] = true;
            }
          }
        }
        
        if (
          variableRoot &&
          !isSystemRetrieveLocal(variableRoot) &&
          variableRoot !== "cdn" &&
          !suppressAsProjectedFieldReference
        ) {
          if (!retrieve[variableRoot]) {
            retrieve[variableRoot] = true;
          }
        }

        // console.log(context + variable);

        for (var x = 0; x < retrieveThese.length; x++) {
          var approved = retrieveThese[x];

          if (approved.indexOf(".") === -1) continue;

          // console.log('--', approved);

          if ((context + variable).indexOf(approved) > -1) {
            var fix = (context + variable).slice(
              (context + variable).indexOf(approved)
            );
            // For approved variables with dots, build nested structure
            var fixRoot = fix.indexOf(".") > -1 && fix.slice(0, fix.indexOf("."));
            var fixProperty = fix.indexOf(".") > -1 && fix.slice(fix.indexOf(".") + 1);
            
            if (fixRoot && fixProperty && retrieveThese.indexOf(fixRoot) > -1) {
              setNestedProperty(fixRoot, fixProperty, true);
            } else {
              retrieve[fix] = true;
            }
          }
        }

        // There are other tokens inside this block
        // process these recursively
        if ((token[0] === "#" || token[0] === "^") && isProjectedFieldInContext) {
          markProjectedFieldContext(contextPath ? contextPath + "." + variable : variable);
        }

        if (type(token[4], "array")) {
          var childContext = context + variable;
          if (
            (token[0] === "#" || token[0] === "^") &&
            !contextSegments[childContext]
          ) {
            contextSegments[childContext] = (
              contextSegments[contextPath] || []
            ).concat([variable]);
          }
          process(childContext, token[4]);
        }
      }
    }
  }


  function isProjectableEntryFieldName(variableName) {
    if (!variableName || variableName.indexOf(".") > -1) return false;
    // Array/list metadata and indexes are not entry fields.
    if (variableName === "length") return false;
    if (/^\d+$/.test(variableName)) return false;
    return /^[a-z][a-zA-Z0-9_]*$/.test(variableName);
  }

  function isLikelyProjectedEntryField(variableName) {
    return isProjectableEntryFieldName(variableName);
  }

  function isLowercaseProjectedEntryField(variableName) {
    if (!isProjectableEntryFieldName(variableName)) return false;
    return /^[a-z0-9_]+$/.test(variableName);
  }

  function markProjectedFieldContext(contextPath) {
    if (!contextPath) return;
    projectedFieldContexts[contextPath] = true;
  }

  function hasProjectedFieldContextAncestor(contextPath) {
    if (!contextPath) return false;

    var current = contextPath;
    while (current) {
      if (projectedFieldContexts[current]) return true;
      var lastDot = current.lastIndexOf(".");
      current = lastDot > -1 ? current.slice(0, lastDot) : "";
    }

    return false;
  }

  // Ensure retrieve.cdn is sorted and deduplicated
  // Always keep it as an array (even if empty) to prevent soft merge issues
  if (retrieve.cdn && Array.isArray(retrieve.cdn)) {
    retrieve.cdn = [...new Set(retrieve.cdn)].sort();
  }

  return {
    partials: partials,
    retrieve: retrieve,
  };

  function collectCdnTargets(tokens) {
    if (!type(tokens, "array")) return;

    var buffer = "";
    var hasDynamicTokens = false;

    for (var j = 0; j < tokens.length; j++) {
      var child = tokens[j];
      if (child[0] === "text") {
        buffer += child[1];
        continue;
      }

      // Any non-text token means we cannot resolve this target statically
      hasDynamicTokens = true;
      break;
    }

    if (hasDynamicTokens) return;

    var target = buffer.trim();

    if (!target) return;
    if (target.indexOf("//") > -1) return;
    if (target.indexOf(" ") > -1) return;
    // Add path traversal checks
    if (target.indexOf("..") > -1) return;
    if (target.indexOf("\\") > -1) return; // Windows path separators
    if (target.indexOf("\0") > -1) return; // Null bytes
    if (target.length > 255) return; // Reasonable length limit

    if (target[0] === "/") target = target.slice(1);

    // Initialize retrieve.cdn as array if it doesn't exist
    if (!retrieve.cdn || !Array.isArray(retrieve.cdn)) {
      retrieve.cdn = [];
    }

    // Add target to array if not already present
    if (retrieve.cdn.indexOf(target) === -1) {
      retrieve.cdn.push(target);
    }
  }
}

// Context paths returned here join their section-token names with a NUL, not
// a ".", so a single dotted section ({{#author.posts}}) stays one segment and
// consumers (getPartials.wrapInContext) don't re-split it into {{#author}}
// {{#posts}}. parseTemplate.CONTEXT_SEPARATOR is exported for those consumers.
var CONTEXT_SEPARATOR = " ";

function getPartialContexts(template, parentContextPath) {
  var partialContexts = {};
  var parsed;

  try {
    parsed = mustache.parse(template || "");
  } catch (e) {
    return partialContexts;
  }

  collect(parentContextPath || "", parsed);

  return partialContexts;

  function addContext(partialName, contextPath) {
    if (!partialContexts[partialName]) partialContexts[partialName] = [];
    if (partialContexts[partialName].indexOf(contextPath) === -1) {
      partialContexts[partialName].push(contextPath);
    }
  }

  function collect(contextPath, tokens) {
    if (!type(tokens, "array")) return;

    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      var tokenType = token[0];
      var tokenValue = token[1];

      if (tokenType === ">") {
        addContext(tokenValue, contextPath);
      }

      if ((tokenType === "#" || tokenType === "^") && type(token[4], "array")) {
        var nextContext = contextPath
          ? contextPath + CONTEXT_SEPARATOR + tokenValue
          : tokenValue;
        collect(nextContext, token[4]);
      }
    }
  }
}

// console.log(parseTemplate('{{#title}}{{#menu}}{{active}}{{/menu}}{{/title}}'));
// console.log(parseTemplate('{{{appCSS}}}'));

parseTemplate.getPartialContexts = getPartialContexts;
parseTemplate.CONTEXT_SEPARATOR = CONTEXT_SEPARATOR;

// Whether `name` is a retrieve local blot knows how to fetch (a module in
// blog/render/retrieve, or a projected-entry alias). Used by setView to tell
// a deliberate retrieve dependency from stale parser output.
parseTemplate.isSystemRetrieveLocal = isSystemRetrieveLocal;

module.exports = parseTemplate;
