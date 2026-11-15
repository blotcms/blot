// Adds next_url and previous_url to a pagination object: root-relative URLs
// of the next and previous page of the listing being rendered, or null.
// Page 1 is the listing's own URL, never /page/1.
//
// How the URL of page N is built:
//
// 1. From a URL pattern of the view (req.viewURLPatterns, e.g.
//    ["/archives", "/archives/page/:page"]) or, for entries.html and
//    tagged.html, of the built-in routes, when it has a :page parameter and
//    every other parameter can be filled from req.params. Page 1 uses the
//    view's pattern without :page if there is one, else drops the trailing
//    /page/<n>.
// 2. Otherwise the request's path with ?page=N, keeping the other query
//    parameters in their order. Page 1 removes page.
//
// Other query parameters are kept on pattern URLs too.
const { compile, parse } = require("path-to-regexp");

const BUILT_IN_PATTERNS = {
  "entries.html": ["/", "/page/:page"],
  "tagged.html": ["/tagged/:tag", "/tagged/:tag/page/:page"],
};

function paramNames(tokens, names = new Set()) {
  for (const token of tokens) {
    if (token.type === "param" || token.type === "wildcard")
      names.add(token.name);
    else if (token.type === "group") paramNames(token.tokens, names);
  }
  return names;
}

function compileOrNull(pattern, params) {
  try {
    const path = compile(pattern)(params);
    return path.startsWith("/") ? path : "/" + path;
  } catch (e) {
    return null;
  }
}

function patternsFor(req) {
  const patterns = Array.isArray(req.viewURLPatterns)
    ? req.viewURLPatterns.filter((p) => typeof p === "string")
    : [];
  const builtIn = BUILT_IN_PATTERNS[req.viewName] || [];

  // Rendered by a built-in route (blog.get sets req.route): its patterns
  // come first, so page 1 of the index is /, not the view's own URL
  if (req.route && builtIn.length)
    return [...builtIn, ...patterns.filter((p) => !builtIn.includes(p))];

  return [...patterns, ...builtIn.filter((p) => !patterns.includes(p))];
}

// Resolves to a function from page number to path, or null when no pattern
// can build the path.
function pathBuilder(req) {
  // Express decodes its route params, but a view's params are matched on an
  // encoded path (models/template/getViewByURL), so decode them all once
  // before compile encodes them again. A value that isn't valid encoding is
  // kept as it is.
  const params = {};
  for (const [name, value] of Object.entries(req.params || {})) {
    let decoded = value;
    if (typeof value === "string") {
      try {
        decoded = decodeURIComponent(value);
      } catch (e) {
        decoded = value;
      }
    }
    params[name] = decoded;
  }
  const patterns = patternsFor(req);

  for (const pattern of patterns) {
    let names;
    try {
      names = paramNames(parse(pattern).tokens);
    } catch (e) {
      continue;
    }

    if (!names.has("page")) continue;

    const rest = { ...params };
    delete rest.page;

    // Page 2 shows whether every other parameter can be filled
    if (compileOrNull(pattern, { ...params, page: "2" }) === null) continue;

    return (n) => {
      if (n >= 2) return compileOrNull(pattern, { ...params, page: String(n) });

      // The same pattern with :page optional
      const optional = compileOrNull(pattern, rest);
      if (optional !== null) return optional;

      // A pattern of the view with the same parameters minus page
      const wanted = [...names].filter((name) => name !== "page").sort();
      for (const other of patterns) {
        let otherNames;
        try {
          otherNames = [...paramNames(parse(other).tokens)].sort();
        } catch (e) {
          continue;
        }
        if (otherNames.join() !== wanted.join()) continue;
        const path = compileOrNull(other, rest);
        if (path !== null) return path;
      }

      // Drop the trailing /page/<n> from the page-2 URL
      const second = compileOrNull(pattern, { ...params, page: "2" });
      if (second && /\/page\/2$/.test(second))
        return second.replace(/\/page\/2$/, "") || "/";

      // Only a page pattern, such as /pagination/:page: page 1 is /pagination/1
      return compileOrNull(pattern, { ...params, page: "1" });
    };
  }

  return null;
}

// "/path?a=1" -> ["/path", URLSearchParams]
function splitURL(req) {
  const original = String(req.originalUrl || req.url || "/").split("#")[0];
  const i = original.indexOf("?");
  const path = i === -1 ? original : original.slice(0, i);
  const query = new URLSearchParams(i === -1 ? "" : original.slice(i + 1));
  return [path || "/", query];
}

function withQuery(path, query) {
  const search = query.toString();
  return search ? path + "?" + search : path;
}

function urlBuilder(req) {
  const [requestPath, requestQuery] = splitURL(req);
  const other = new URLSearchParams(requestQuery);
  other.delete("page");

  const build = pathBuilder(req);

  return function url(n) {
    if (build) {
      const path = build(n);
      if (path !== null) return withQuery(path, other);
    }

    const query = new URLSearchParams(requestQuery);
    if (n >= 2) query.set("page", String(n));
    else query.delete("page");
    return withQuery(requestPath, query);
  };
}

function validPage(n) {
  n = Number(n);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// Returns a copy of pagination with next_url and previous_url
module.exports = function paginationURLs(req, pagination) {
  const copy = { ...(pagination || {}) };
  const next = validPage(copy.next);
  const previous = validPage(copy.previous);
  let url;

  const lazy = (n) => {
    if (n === null) return null;
    if (!url) url = urlBuilder(req || {});
    return url(n);
  };

  copy.next_url = lazy(next);
  copy.previous_url = lazy(previous);

  return copy;
};
