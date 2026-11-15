const key = require("./key");
const client = require("models/client");
const { parse } = require("url");
const urlNormalizer = require("helper/urlNormalizer");
const { parseViewPatterns, resolveView } = require("./viewURLPatterns");

/**
 * Resolve many URLs against a template's views at once.
 *
 * Calling getViewByURL in a loop costs a round trip per URL. This fetches
 * the template's URL patterns and every URL's exact-URL key together, so the
 * cost does not grow with the number of URLs.
 *
 * @param {string} templateID - The ID of the template.
 * @param {string[]} urls - The URLs to match.
 * @returns {Promise<Array>} viewNames, an array parallel to urls containing a
 *   view name or null.
 */
module.exports = async function getViewsByURLs(templateID, urls) {
  if (!templateID || typeof templateID !== "string") {
    throw new Error("Invalid templateID");
  }

  if (!Array.isArray(urls)) {
    throw new Error("Invalid urls");
  }

  if (!urls.length) return [];

  // Exact-URL keys only decide for views without patterns, but which ones
  // is known only once the patterns are read, so both are fetched together
  const exactURLs = urls.map((url) =>
    url && typeof url === "string" ? urlNormalizer(url) : ""
  );
  const exactIndexes = [];

  exactURLs.forEach((exactURL, index) => {
    if (exactURL) exactIndexes.push(index);
  });

  const [viewPatternStrings, exactKeyViews] = await Promise.all([
    client.hGetAll(key.urlPatterns(templateID)),
    exactIndexes.length
      ? client.mGet(
          exactIndexes.map((index) => key.url(templateID, exactURLs[index]))
        )
      : [],
  ]);

  const entries = parseViewPatterns(viewPatternStrings);
  const exactKeyByIndex = new Map(
    exactIndexes.map((index, position) => [index, exactKeyViews[position]])
  );

  const viewNames = urls.map((url, index) => {
    if (!url || typeof url !== "string") return null;

    const { pathname } = parse(url);
    const matched = resolveView(
      entries,
      viewPatternStrings,
      pathname,
      exactKeyByIndex.get(index)
    );

    return matched ? matched.viewName : null;
  });

  return viewNames;
};
