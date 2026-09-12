const lookupFile = require("./lookupFile");
const blogHosts = require("../../lib/blogHosts");

const htmlExtRegex = /\.html$/;
const fileExtRegex = /[^/]*\.[^/]*$/;
// Strict regex that requires matching quotes and parentheses
const urlRegex = /url\((?:([^'"()]+)|['"]([^'"]+)['"]) *\)/gi;

module.exports = async function replaceCssUrls(blog, css, log = () => {}) {
  try {
    const blogID = blog.id;
    const cacheID = blog.cacheID;

    const hosts = blogHosts(blog);

    // Create regex patterns for each host
    const hostPatterns = hosts.map(
      (host) => new RegExp(`^(?:https?:)?//${host}`)
    );

    const processedUrls = new Map();
    const urlMatches = [...css.matchAll(urlRegex)];

    // Skip if no URLs found
    if (!urlMatches.length) {
      return css;
    }

    // Process all URLs in parallel
    await Promise.all(
      urlMatches.map(async (match) => {
        // Use the unquoted or quoted URL, whichever is present
        let url = match[1] || match[2];

        // Skip data URLs
        if (url.startsWith("data:")) {
          return;
        }

        // Check if URL matches any of our host patterns
        const matchingHostPattern = hostPatterns.find((pattern) =>
          pattern.test(url)
        );
        if (matchingHostPattern) {
          // Strip the host part if it matches
          url = url.replace(matchingHostPattern, "");
        } else if (url.includes("://")) {
          // Skip external URLs that don't match our hosts
          return;
        }

        // Skip HTML files and files without extensions
        if (htmlExtRegex.test(url) || !fileExtRegex.test(url)) {
          return;
        }

        const cdnUrl = await lookupFile(blogID, cacheID, url);
        if (cdnUrl && cdnUrl !== "ENOENT") {
          // Store the original URL (with or without host) as the key
          processedUrls.set(match[1] || match[2], cdnUrl);
          log(`Replacing ${url} with ${cdnUrl}`);
        } else {
          log(`No file found in folder: ${url}`);
        }
      })
    );

    // Skip if no URLs were processed
    if (!processedUrls.size) {
      return css;
    }

    // Replace only valid URLs
    return css.replace(urlRegex, (match, unquotedUrl, quotedUrl) => {
      const url = unquotedUrl || quotedUrl;
      const cdnUrl = processedUrls.get(url);
      return cdnUrl ? `url(${cdnUrl})` : match;
    });
  } catch (err) {
    console.warn("URL replacement failed:", err);
    return css;
  }
};
