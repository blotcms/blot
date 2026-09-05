const key = require("./key");
const client = require("models/client");
const { parse } = require("url");
const urlNormalizer = require("helper/urlNormalizer");
const { matchViewPatterns, parseViewPatterns } = require("./viewURLPatterns");

/**
 * Resolve many URLs against a template's views at once.
 *
 * Calling getViewByURL in a loop costs two redis round trips per URL. This
 * fetches the template's URL patterns once and looks up the remaining URLs in
 * a single mGet, so the cost does not grow with the number of URLs.
 *
 * @param {string} templateID - The ID of the template.
 * @param {string[]} urls - The URLs to match.
 * @param {function} callback - Callback function (err, viewNames) where
 *   viewNames is an array parallel to urls containing a view name or null.
 */
module.exports = function getViewsByURLs(templateID, urls, callback) {
  if (!templateID || typeof templateID !== "string") {
    return callback(new Error("Invalid templateID"));
  }

  if (!Array.isArray(urls)) {
    return callback(new Error("Invalid urls"));
  }

  if (!urls.length) return callback(null, []);

  (async function () {
    try {
      const viewPatternStrings = await client.hGetAll(
        key.urlPatterns(templateID)
      );

      const views = viewPatternStrings
        ? parseViewPatterns(viewPatternStrings)
        : [];

      const viewNames = urls.map((url) => {
        if (!url || typeof url !== "string") return null;

        const { pathname } = parse(url);
        const matched = matchViewPatterns(views, pathname);

        return matched ? matched.viewName : null;
      });

      // Views whose URL was stored verbatim rather than as a pattern
      const unmatched = [];

      viewNames.forEach(function (viewName, index) {
        if (!viewName && typeof urls[index] === "string" && urls[index])
          unmatched.push(index);
      });

      if (unmatched.length) {
        const urlKeys = unmatched.map((index) =>
          key.url(templateID, urlNormalizer(urls[index]))
        );

        const resolved = await client.mGet(urlKeys);

        unmatched.forEach(function (index, position) {
          viewNames[index] = resolved[position] || null;
        });
      }

      callback(null, viewNames);
    } catch (err) {
      callback(err);
    }
  })();
};
