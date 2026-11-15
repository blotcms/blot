const key = require("./key");
const client = require("models/client");
const debug = require("debug")("blot:template:getViewByURLPattern");
const { parse } = require("url");
const urlNormalizer = require("helper/urlNormalizer");
const { parseViewPatterns, resolveView } = require("./viewURLPatterns");

/**
 * Get a view by matching its URL, most explicit first (see viewURLPatterns).
 *
 * @param {string} templateID - The ID of the template.
 * @param {string} url - The URL to match.
 * @returns {Promise<{viewName: ?string, pattern: ?string, params: ?object, query: ?object}>}
 */
module.exports = async function getViewByURLPattern(templateID, url) {
  debug("Looking up views for templateID:", templateID, "URL:", url);

  if (!templateID || typeof templateID !== "string") {
    const err = new Error("Invalid templateID");
    debug(err.message);
    throw err;
  }

  if (!url || typeof url !== "string") {
    const err = new Error("Invalid URL");
    debug(err.message);
    throw err;
  }

  try {
    const { pathname, query } = parse(url, true); // `true` parses query string into an object

    debug("Normalized URL:", pathname);

    // The exact-URL key is only used for views without patterns, so it is
    // fetched alongside the patterns, in one round trip
    const exactURL = urlNormalizer(url);
    const [viewPatternStrings, exactKeyView] = await Promise.all([
      client.hGetAll(key.urlPatterns(templateID)),
      exactURL ? client.get(key.url(templateID, exactURL)) : null,
    ]);

    const entries = parseViewPatterns(viewPatternStrings);
    const matched = resolveView(
      entries,
      viewPatternStrings,
      pathname,
      exactKeyView
    );

    if (matched) {
      debug(
        "Matched pattern:",
        matched.pattern,
        "with URL:",
        pathname,
        "in view:",
        matched.viewName
      );
      return {
        viewName: matched.viewName,
        pattern: matched.pattern,
        params: matched.params,
        query,
      };
    }

    debug("No view found for URL:", url);
    return { viewName: null, pattern: null, params: null, query: null };
  } catch (error) {
    debug("Error while processing URL:", error);
    throw error;
  }
};
