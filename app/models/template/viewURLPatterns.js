const { match, parse } = require("path-to-regexp");

/**
 * Normalize a pathname by adding a leading slash, removing trailing slashes, and converting to lowercase.
 *
 * @param {string} pathname - The pathname to normalize.
 * @returns {string} - The normalized pathname.
 */
function normalizePathname(pathname) {
  if (!pathname || typeof pathname !== "string") {
    return "/";
  }
  return `/${pathname.replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase()}`;
}

const EXACT = 0;
const PARAMETERS = 1;
const WILDCARDS = 2;

/**
 * Rank a parsed pattern, most explicit first (lower sorts first).
 *
 * @param {Array} tokens - The tokens path-to-regexp parsed the pattern into.
 * @returns {Array} - [class, -literalSegments, -literalCharacters], where class
 *   is EXACT, PARAMETERS or WILDCARDS.
 */
function rankTokens(tokens) {
  let hasParam = false;
  let hasWildcard = false;
  let literalChars = 0;
  let text = "";

  (function walk(list) {
    for (const token of list) {
      if (token.type === "text") {
        literalChars += token.value.length;
        text += token.value;
      } else if (token.type === "param") {
        hasParam = true;
        text += "\u0000";
      } else if (token.type === "wildcard") {
        hasWildcard = true;
        text += "\u0000";
      } else if (token.type === "group") {
        walk(token.tokens);
      }
    }
  })(tokens);

  // A literal segment is a /-separated piece made only of text
  const literalSegments = text
    .split("/")
    .filter((segment) => segment && !segment.includes("\u0000")).length;

  const kind = hasWildcard ? WILDCARDS : hasParam ? PARAMETERS : EXACT;

  return [kind, -literalSegments, -literalChars];
}

function compareEntries(a, b) {
  return (
    a.rank[0] - b.rank[0] ||
    a.rank[1] - b.rank[1] ||
    a.rank[2] - b.rank[2] ||
    a.viewName.localeCompare(b.viewName)
  );
}

/**
 * Parse view patterns from the Redis hash into a list ranked most explicit
 * first. Each (view, pattern) pair is ranked on its own: exact URLs, then
 * patterns with parameters, then wildcards; within a class, more literal path
 * segments, then more literal characters, then the view name.
 *
 * @param {object} viewPatternStrings - The Redis hash object with view patterns.
 * @returns {Array} - Entries {viewName, pattern, kind, rank}, best first.
 */
function parseViewPatterns(viewPatternStrings) {
  const entries = [];

  for (const [viewName, patterns] of Object.entries(viewPatternStrings || {})) {
    // Patterns are stored as JSON strings
    for (const pattern of JSON.parse(patterns)) {
      try {
        const { tokens } = parse(normalizePathname(pattern));
        const rank = rankTokens(tokens);
        entries.push({ viewName, pattern, kind: rank[0], rank });
      } catch (err) {
        // A pattern that does not parse never matches
      }
    }
  }

  return entries.sort(compareEntries);
}

/**
 * Safely match a URL against a pattern.
 *
 * @param {string} rawPattern - The raw URL pattern to match.
 * @param {string} normalizedPathname - The normalized URL pathname.
 * @returns {object|null} - The match result or null if no match.
 */
function safeMatch(rawPattern, normalizedPathname) {
  const normalizedPattern = normalizePathname(rawPattern);

  // Use path-to-regexp to create a matching function
  const matchPattern = match(normalizedPattern, { decode: false });

  return matchPattern(normalizedPathname);
}

/**
 * Find the best entry of one kind whose pattern matches a pathname.
 *
 * @param {Array} entries - As returned by parseViewPatterns.
 * @param {string} pathname - The pathname to match, without a query string.
 * @param {number} kind - EXACT, PARAMETERS or WILDCARDS; omit to match any.
 * @returns {object|null} - {viewName, pattern, params} or null.
 */
function matchViewPatterns(entries, pathname, kind) {
  const normalizedPathname = normalizePathname(pathname);

  for (const entry of entries) {
    if (kind !== undefined && entry.kind !== kind) continue;

    try {
      const matchResult = safeMatch(entry.pattern, normalizedPathname);

      if (matchResult) {
        return {
          viewName: entry.viewName,
          pattern: entry.pattern,
          params: matchResult.params,
        };
      }
    } catch (err) {
      // Continue to the next pattern without failing completely
    }
  }

  return null;
}

/**
 * Resolve a pathname to a view: exact patterns, then the exact-URL key if the
 * view it names has no patterns, then parameter patterns, then wildcards.
 *
 * @param {Array} entries - As returned by parseViewPatterns.
 * @param {object} viewPatternStrings - The Redis hash the entries came from.
 * @param {string} pathname - The pathname to match, without a query string.
 * @param {?string} exactKeyView - The view named by the exact-URL key, if any.
 * @returns {object|null} - {viewName, pattern, params}; pattern is null for an
 *   exact-URL key match.
 */
function resolveView(entries, viewPatternStrings, pathname, exactKeyView) {
  const exact = matchViewPatterns(entries, pathname, EXACT);
  if (exact) return exact;

  // Only views without stored patterns (legacy) are routed by their key
  if (
    exactKeyView &&
    !Object.prototype.hasOwnProperty.call(
      viewPatternStrings || {},
      exactKeyView
    )
  ) {
    return { viewName: exactKeyView, pattern: null, params: null };
  }

  return (
    matchViewPatterns(entries, pathname, PARAMETERS) ||
    matchViewPatterns(entries, pathname, WILDCARDS)
  );
}

module.exports = {
  matchViewPatterns,
  normalizePathname,
  parseViewPatterns,
  resolveView,
  safeMatch,
};
