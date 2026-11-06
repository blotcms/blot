const each = require("../eachEl");
const Url = require("url");
const fetch = require("node-fetch");
const withPluginCallback = require("../withPluginCallback");

async function render($) {
  await each($, "a", async (el) => {
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

      if (!data || !data.html) return;

      var html = data.html;

      $(el).replaceWith(html);
    } catch (e) {
      return;
    }
  });
}

module.exports = {
  render: withPluginCallback(render),
  category: "embeds",
  title: "Tweets",
  description: "Embed posts from Twitter links",
};
