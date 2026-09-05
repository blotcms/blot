const { match } = require("path-to-regexp");

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

/**
 * Parse view patterns from Redis hash object.
 *
 * @param {object} viewPatternStrings - The Redis hash object with view patterns.
 * @returns {Array} - An array of [viewName, urlPatterns].
 */
function parseViewPatterns(viewPatternStrings) {
  return Object.entries(viewPatternStrings)
    .map(([viewName, patterns]) => [
      viewName,
      JSON.parse(patterns), // Patterns are stored as JSON strings
    ])
    .sort(([viewNameA], [viewNameB]) => viewNameA.localeCompare(viewNameB));
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
 * Find the first view whose URL patterns match a pathname.
 *
 * @param {Array} views - An array of [viewName, urlPatterns], as returned by parseViewPatterns.
 * @param {string} pathname - The pathname to match, without a query string.
 * @returns {object|null} - {viewName, pattern, params} or null if nothing matched.
 */
function matchViewPatterns(views, pathname) {
  const normalizedPathname = normalizePathname(pathname);

  for (const [viewName, urlPatterns] of views) {
    for (const rawPattern of urlPatterns) {
      try {
        const matchResult = safeMatch(rawPattern, normalizedPathname);

        if (matchResult) {
          return {
            viewName,
            pattern: rawPattern,
            params: matchResult.params,
          };
        }
      } catch (err) {
        // Continue to the next pattern without failing completely
      }
    }
  }

  return null;
}

module.exports = {
  matchViewPatterns,
  normalizePathname,
  parseViewPatterns,
  safeMatch,
};
