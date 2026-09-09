var getView = require("./getView");
var async = require("async");
var ensure = require("helper/ensure");
var promisify = require("util").promisify;
var parseTemplate = require("./parseTemplate");
var mergeRetrieve = require("./util/mergeRetrieve");

module.exports = function getPartials(
  blogID,
  templateID,
  partials,
  callback,
  contextMap,
  parentContextPath
) {
  try {
    ensure(blogID, "string")
      .and(templateID, "string")
      .and(partials, "object")
      .and(callback, "function");

    if (!contextMap) contextMap = {};
    if (!parentContextPath) parentContextPath = "";
  } catch (e) {
    return callback(e);
  }

  var Entry = require("../entry");
  var allPartials = {};
  var retrieve = {};

  for (var i in partials) if (partials[i]) allPartials[i] = partials[i];

  Object.keys(partials || {}).forEach(function (partialName) {
    // Keep any previously-discovered usage contexts for this partial.
    // Falling back to the parent context should only happen when no
    // context has been recorded yet.
    if (!contextMap[partialName] || !contextMap[partialName].length) {
      addContext(partialName, parentContextPath || "");
    }
  });

  function addContext(partialName, contextPath) {
    if (!contextMap[partialName]) contextMap[partialName] = [];
    if (contextMap[partialName].indexOf(contextPath) === -1) {
      contextMap[partialName].push(contextPath);
    }
  }

  function wrapInContext(content, contextPath) {
    if (!contextPath) return content || "";

    // contextPath segments are joined by parseTemplate.CONTEXT_SEPARATOR, so a
    // dotted section name ({{#author.posts}}) stays a single segment here and
    // is re-emitted as one {{#author.posts}} tag rather than nested sections.
    var segments = contextPath
      .split(parseTemplate.CONTEXT_SEPARATOR)
      .filter(Boolean);
    var wrapped = content || "";

    for (var i = segments.length - 1; i >= 0; i--) {
      wrapped = "{{#" + segments[i] + "}}" + wrapped + "{{/" + segments[i] + "}}";
    }

    return wrapped;
  }

  function parseRetrieveInContext(content, contextPath) {
    return parseTemplate(wrapInContext(content, contextPath)).retrieve || {};
  }

  // Merge only the context-independent dependencies out of a partial's stored
  // retrieve: real retrieve locals blot can fetch, user options, and cdn.
  // Skips bare non-local keys (e.g. `title`) so they don't leak to the top
  // level when the partial is used inside an entry section.
  function mergeStoredDependencies(target, viewRetrieve) {
    if (!viewRetrieve) return;

    var deps = {};

    Object.keys(viewRetrieve).forEach(function (key) {
      if (
        key === "cdn" ||
        key === "includeDraft" ||
        key === "filters" ||
        parseTemplate.isSystemRetrieveLocal(key)
      ) {
        deps[key] = viewRetrieve[key];
      }
    });

    mergeRetrieve(target, deps);
  }

  function mergePartialContexts(viewContent, inheritedContexts) {
    var merged = {};

    (inheritedContexts || [""]).forEach(function (contextPath) {
      var partialContexts = parseTemplate.getPartialContexts(viewContent || "", contextPath);

      Object.keys(partialContexts).forEach(function (partialName) {
        if (!merged[partialName]) merged[partialName] = [];

        partialContexts[partialName].forEach(function (path) {
          if (merged[partialName].indexOf(path) === -1) {
            merged[partialName].push(path);
          }
        });
      });
    });

    return merged;
  }

  fetchList(partials, function () {
    return callback(null, allPartials, retrieve);
  });

  function fetchList(partials, done) {
    async.eachOfSeries(
      partials,
      function (value, partial, next) {
        var nextCalled = false;
        var finish = function () {
          if (nextCalled) return;
          nextCalled = true;
          next();
        };
        var inheritedContexts =
          contextMap[partial] && contextMap[partial].length
            ? contextMap[partial]
            : [""];

        // Don't fetch a partial if we've got it already.
        // Partials which returned nothing are set as
        // empty strings to prevent any infinities.
        if (allPartials[partial] !== null && allPartials[partial] !== undefined)
          return finish();

        // If the partial's name starts with a slash,
        // it is a path to an entry.
        if (partial.charAt(0) === "/") {
          Entry.getByPath(blogID, partial, function (entry) {
            // empty string and not undefined to
            // prevent infinite fetches
            allPartials[partial] = "";

            if (!entry || !entry.html) {
              return finish();
            }

            // Only allow access to entries which exist and are public
            if (!entry.deleted && !entry.draft && !entry.scheduled) {
              allPartials[partial] = entry.html;
            }

            finish();
          });
          return;
        }

        // If the partial's name doesn't start with a slash,
        // it is the name of a tempalte view.
        if (partial.charAt(0) !== "/") {
          getView(templateID, partial, function (err, view) {
            if (view) {
              allPartials[partial] = view.content;

              inheritedContexts.forEach(function (contextPath) {
                if (!contextPath) {
                  mergeRetrieve(retrieve, view.retrieve || {});
                } else {
                  mergeRetrieve(
                    retrieve,
                    parseRetrieveInContext(view.content || "", contextPath)
                  );
                  // The contextual parse only sees the partial's visible
                  // content. Its stored retrieve can also carry dependencies
                  // that aren't context-bound - an explicit retrieve.latest_entry
                  // for a local, includeDraft/filters, cdn targets. Those still
                  // apply wherever the partial is embedded.
                  mergeStoredDependencies(retrieve, view.retrieve);
                }
              });

              var nestedPartials = mergePartialContexts(
                view.content,
                inheritedContexts
              );

              Object.keys(nestedPartials).forEach(function (nestedPartial) {
                nestedPartials[nestedPartial].forEach(function (nestedContextPath) {
                  addContext(nestedPartial, nestedContextPath);
                });
              });

              fetchList(view.partials, finish);
            } else {
              allPartials[partial] = "";
              finish();
            }
          });
          return;
        }

        finish();
      },
      done
    );
  }
};
