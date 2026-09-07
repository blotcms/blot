const fetch = require("node-fetch");
const cheerio = require("cheerio");

const ERROR_MESSAGE = "Could not retrieve song properties";

// bandcamp.com or <artist>.bandcamp.com, nothing else.
const BANDCAMP_HOST = /^([a-z0-9-]+\.)*bandcamp\.com$/i;

// Bandcamp is not an oEmbed provider, so unlike the other video embeds this
// one scrapes the target page itself. To keep that from being an SSRF sink
// (it is not routed through the airlock - see config/airlock/README.md) it
// never fetches the raw user href: the host is pinned to bandcamp.com, the
// URL is rebuilt from just the validated host + path (no scheme downgrade,
// no credentials, no port, no query), and redirects are not followed - a
// 3xx (or anything non-2xx) is treated as "not a bandcamp track".
module.exports = async function (href, callback) {
  try {
    let parsed;

    try {
      parsed = new URL(href);
    } catch (e) {
      return callback(new Error(ERROR_MESSAGE));
    }

    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();

    if (!BANDCAMP_HOST.test(host)) {
      return callback(new Error(ERROR_MESSAGE));
    }

    if (!path || !path.match(/\/(album|track)/)) {
      return callback(new Error(ERROR_MESSAGE));
    }

    // Rebuild from validated parts - never fetch `href` directly.
    const safeUrl = "https://" + host + parsed.pathname;

    const res = await fetch(safeUrl, { redirect: "manual" });

    if (!res.ok) {
      return callback(new Error(ERROR_MESSAGE));
    }

    const body = await res.text();
    const $ = cheerio.load(body, null, false);

    const width = Number($('meta[property="og:video:width"]').attr("content"));
    const height = Number(
      $('meta[property="og:video:height"]').attr("content")
    );

    let src = $('meta[property="og:video"]').attr("content");

    if (!src || isNaN(height) || isNaN(width)) {
      return callback(new Error(ERROR_MESSAGE));
    }

    // we prepend a zero-width char because of a weird
    // bug on mobile safari where if the embed is the first child,
    // the video player will not show. This causes issues with
    // inline elements displaying (adds extra space) solution needed
    // that doesn't disrupt page layout...
    const embedHTML = `<div style="width:0;height:0"> </div><div class="videoContainer bandcamp" style="padding-bottom: ${height}px"><iframe width="${width}" height="${height}" src="${src}" frameborder="0" webkitallowfullscreen mozallowfullscreen allowfullscreen></iframe></div>`;

    callback(null, embedHTML);
  } catch (error) {
    callback(new Error(ERROR_MESSAGE));
  }
};
