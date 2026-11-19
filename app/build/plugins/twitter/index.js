const eachConcurrent = require("../eachElConcurrent");
const Url = require("url");
const fetch = require("../fetchWithTimeout");
var { report } = require("build/flags");

// The link stays in the post, so it still works; the flag says it wasn't
// embedded
function failed(href) {
  report({ code: "EMBED_FAILED", targets: [href] });
}

async function render($) {
  await eachConcurrent($, "a", lookup, apply);

  async function lookup(el) {
    var href, host, text;

    try {
      href = $(el).attr("href");
      text = $(el).text();
      host = Url.parse(href).host;
    } catch (e) {
      return;
    }

    // Ensure we managed to extract everything from the url
    if (!href || !text || !host) return;

    // Look for bare links
    if (href !== text) return;

    // which point to a post on flickr, include all flickr hosts including www. subdomain
    if (!/^(www\.)?(twitter\.com|x\.com)$/.test(host)) return;

    var params = {
      url: href,
      format: "json",
    };

    var oembedUrl =
      "https://publish.twitter.com/oembed?" +
      new URLSearchParams(params).toString();

    // A failed request or response is skipped, leaving the link as it was
    try {
      const res = await fetch(oembedUrl);
      const data = await res.json();

      if (!data || !data.html) return { href, failed: true };

      return { href, html: data.html };
    } catch (e) {
      return { href, failed: true };
    }
  }

  function apply(el, result) {
    if (result.failed) return failed(result.href);
    $(el).replaceWith(result.html);
  }
}

module.exports = {
  render,
  category: "embeds",
  title: "Tweets",
  description: "Embed posts from Twitter links",
};
