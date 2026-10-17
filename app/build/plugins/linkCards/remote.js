// href is a user-supplied URL from a bare link in a post, so every fetch in
// this plugin goes through the airlock's forward proxy (helper/airlock).
// assertProxyReady inside this fetch throws in production if the proxy is
// missing rather than falling back to a direct connection; callers already
// treat a throw/rejection as "no metadata" and degrade to a hostname-only
// card.
const { fetch } = require("helper/airlock");

const { REQUEST_TIMEOUT } = require("./constants");
const { transformerLookup } = require("./transformers");
const { createHTMLTransform, extractMetadataFromHTML } = require("./metadata");

async function fetchMetadata(href, transformer) {
  // transformerLookup handles a null transformer by going straight to the
  // fallback, so there's no need to special-case it here.
  return transformerLookup(transformer, href, createHTMLTransform(href), () =>
    fetchMetadataDirect(href)
  );
}

async function fetchMetadataDirect(href) {
  try {
    const response = await fetch(href, {
      airlockLabel: "linkCards/metadata",
      redirect: "follow",
      timeout: REQUEST_TIMEOUT,
      headers: {
        "user-agent": "Blot Link Cards (+https://blot.im)",
      },
    });

    if (!response.ok) return null;

    const html = await response.text();
    // Resolve relative og:image / favicon URLs against where we actually
    // ended up, not the pre-redirect link.
    return extractMetadataFromHTML(html, response.url || href);
  } catch (err) {
    return null;
  }
}

module.exports = {
  fetchMetadata,
  fetchMetadataDirect,
};
