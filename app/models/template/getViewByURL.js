const key = require("./key");
const client = require("models/client");
const debug = require("debug")("blot:template:getViewByURLPattern");
const { parse } = require("url");
const urlNormalizer = require("helper/urlNormalizer");
const { matchViewPatterns, parseViewPatterns } = require("./viewURLPatterns");

/**
 * Get a view by matching its URL pattern.
 *
 * @param {string} templateID - The ID of the template.
 * @param {string} url - The URL to match.
 * @param {function} callback - Callback function (err, viewName, params, query).
 */
module.exports = async function getViewByURLPattern(templateID, url, callback) {
  debug("Looking up views for templateID:", templateID, "URL:", url);

  if (!templateID || typeof templateID !== "string") {
    const err = new Error("Invalid templateID");
    debug(err.message);
    return callback(err);
  }

  if (!url || typeof url !== "string") {
    const err = new Error("Invalid URL");
    debug(err.message);
    return callback(err);
  }

  try {
    const { pathname, query } = parse(url, true); // `true` parses query string into an object

    debug("Normalized URL:", pathname);

    // Fetch all views and their patterns for the given template ID
    const viewPatternStrings = await client.hGetAll(key.urlPatterns(templateID));

    if (viewPatternStrings) {
      const views = parseViewPatterns(viewPatternStrings);
      const matched = matchViewPatterns(views, pathname);

      if (matched) {
        debug(
          "Matched pattern:",
          matched.pattern,
          "with URL:",
          pathname,
          "in view:",
          matched.viewName
        );
        return callback(null, matched.viewName, matched.params, query);
      }

      debug("No matching URL pattern found for URL:", url);
    } else {
      debug("No URL patterns found for templateID:", templateID);
    }

    // Fall back to matching the URL directly
    const viewName = await client.get(key.url(templateID, urlNormalizer(url)));

    if (viewName) {
      debug("Found view by URL:", viewName);
      return callback(null, viewName, null, query);
    }

    debug("No view found for URL:", url);
    return callback(null, null, null, null);
  } catch (error) {
    debug("Error while processing URL:", error);
    return callback(error, null, null, null);
  }
};
