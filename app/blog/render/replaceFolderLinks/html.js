const parse5 = require("parse5");

const htmlExtRegex = /\.html$/;
const fileExtRegex = /[^/]*\.[^/]*$/;

const lookupFile = require("./lookupFile");
const blogHosts = require("../../lib/blogHosts");

const parseSrcset = (value) => {
  if (typeof value !== "string") {
    return null;
  }

  const candidates = value.split(",");
  const parsed = [];

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) {
      return null;
    }

    const parts = trimmed.split(/\s+/);
    const url = parts.shift();
    if (!url) {
      return null;
    }

    parsed.push({
      url,
      descriptor: parts.length ? parts.join(" ") : "",
    });
  }

  return parsed;
};

// Cheap pre-scan of the raw output string, run before the expensive
// parse5.parse + tree-walk below. Most rendered pages have no folder-file
// links at all, so this lets us skip the parse entirely in the common case.
//
// This deliberately does NOT try to inspect or validate attribute *values*
// (host-matching, file extension, data: URLs, etc) the way the real
// per-node walk below does - only whether one of these attribute names
// appears in the raw text at all. Pairing quotes to extract a value out of
// unparsed HTML text is not reliable: earlier text (a <script> body, a
// comment, anything) can contain a stray quote character that pairs with a
// later *real* attribute's quote, silently consuming it and hiding it from
// this scan. A pure name-presence check can't have that failure mode - the
// worst case is falling through to the real parse for a page that turns
// out to need no changes, matching the same coarse presence-only style
// replaceFolderLinks/css.js already uses for its `url(...)` pre-check.
const candidateAttrRegex = /(?<![\w-])(?:href|src|poster|srcset)\s*=/i;

function mayNeedFolderLinkReplacement(html) {
  return candidateAttrRegex.test(html);
}

module.exports = async function replaceFolderLinks(blog, html, log = () => {}) {
  try {
    const blogID = blog.id;
    const cacheID = blog.cacheID;
    const hosts = blogHosts(blog);

    // Create regex patterns for each host
    const hostPatterns = hosts.map(
      (host) => new RegExp(`^(?:https?:)?//${host}`)
    );

    // Skip the expensive parse5 parse + tree-walk entirely when nothing in
    // the output could possibly need rewriting.
    if (!mayNeedFolderLinkReplacement(html)) {
      return html;
    }

    const document = parse5.parse(html);
    const elements = [];
    const promises = [];
    const stack = [...document.childNodes];
    let changes = 0;

    while (stack.length > 0) {
      const node = stack.pop();

      if (node.attrs) {
        let hasMatchingAttr = false;
        for (let i = 0; i < node.attrs.length; i++) {
          const attr = node.attrs[i];
          if (attr.name === "href" || attr.name === "src" || attr.name === "poster") {

            // Ensure attr.value is a string
            if (typeof attr.value !== "string") {
              continue;
            }

            // Skip data URLs
            if (attr.value.startsWith("data:")) {
              continue;
            }

            // Check if URL is relative or matches any of the host patterns
            const isRelative = attr.value.indexOf("://") === -1;
            const matchesHost = hostPatterns.some(pattern => pattern.test(attr.value));
            
            if (isRelative || matchesHost) {
              hasMatchingAttr = true;
              break;
            }
          }

          if (attr.name === "srcset") {
            const candidates = parseSrcset(attr.value);
            if (!candidates) {
              continue;
            }

            const hasRelative = candidates.some((candidate) => {
              if (!candidate.url || candidate.url.startsWith("data:")) {
                return false;
              }
              const isRelative = candidate.url.indexOf("://") === -1;
              const matchesHost = hostPatterns.some(pattern => pattern.test(candidate.url));
              return isRelative || matchesHost;
            });

            if (hasRelative) {
              hasMatchingAttr = true;
              break;
            }
          }
        }
        if (hasMatchingAttr) elements.push(node);
      }

      if (node.childNodes) {
        stack.push(...node.childNodes);
      }
    }

    for (const node of elements) {
      for (const attr of node.attrs) {
        if (attr.name === "href" || attr.name === "src" || attr.name === "poster") {
          let value = attr.value;
            
          // Remove host if it matches any of the patterns
          hostPatterns.forEach(pattern => {
            value = value.replace(pattern, '');
          });

          // Only process if it's not an HTML file and has a file extension
          if (!htmlExtRegex.test(value) && fileExtRegex.test(value)) {
            promises.push(
              (async () => {
                const result = await lookupFile(blogID, cacheID, value);

                if (result === "ENOENT") {
                  log(`No file found in folder: ${value}`);
                  return;
                }

                log(`Replacing ${attr.value} with ${result}`);
                attr.value = result;
                changes++;
              })()
            );
          }
        }

        if (attr.name === "srcset") {
          const candidates = parseSrcset(attr.value);
          if (!candidates) {
            continue;
          }

          promises.push(
            (async () => {
              const rebuilt = [];

              for (const candidate of candidates) {
                const originalUrl = candidate.url;

                if (!originalUrl || originalUrl.startsWith("data:")) {
                  rebuilt.push(
                    candidate.descriptor
                      ? `${originalUrl} ${candidate.descriptor}`
                      : originalUrl
                  );
                  continue;
                }

                const isRelative = originalUrl.indexOf("://") === -1;
                const matchesHost = hostPatterns.some((pattern) =>
                  pattern.test(originalUrl)
                );

                let rewrittenUrl = originalUrl;
                let lookupPath = originalUrl;

                if (matchesHost) {
                  hostPatterns.forEach((pattern) => {
                    lookupPath = lookupPath.replace(pattern, "");
                  });
                }

                if (isRelative || matchesHost) {
                  if (!htmlExtRegex.test(lookupPath) && fileExtRegex.test(lookupPath)) {
                    const result = await lookupFile(blogID, cacheID, lookupPath);

                    if (result === "ENOENT") {
                      log(`No file found in folder: ${lookupPath}`);
                      rewrittenUrl = originalUrl;
                    } else {
                      log(`Replacing ${originalUrl} with ${result}`);
                      rewrittenUrl = result;
                      changes++;
                    }
                  } else {
                    rewrittenUrl = originalUrl;
                  }
                } else {
                  rewrittenUrl = originalUrl;
                }

                rebuilt.push(
                  candidate.descriptor
                    ? `${rewrittenUrl} ${candidate.descriptor}`
                    : rewrittenUrl
                );
              }

              attr.value = rebuilt.join(", ");
            })()
          );
        }
      }
    }

    await Promise.all(promises);
    return changes ? parse5.serialize(document) : html;
  } catch (err) {
    console.warn("Parse5 parsing failed:", err);
    return html;
  }
};
