/* from flickr 

oEmbed Endpoint

The official oEmbed endpoint for Bluesky posts is 

https://www.flickr.com/services/oembed/

    url (required): flickr.com or flic.kr url to a post or gallery
    format (optional): json
*/

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
    if (!/^(www\.)?(flickr\.com|flic\.kr)$/.test(host)) return;

    var params = {
      url: href,
      format: "json",
    };

    var oembedUrl =
      "https://www.flickr.com/services/oembed/?" +
      new URLSearchParams(params).toString();

    // A failed request or response is skipped, leaving the link as it was
    try {
      const res = await fetch(oembedUrl);
      const data = await res.json();

      if (!data || typeof data.html !== "string") return;

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
  title: "Flickr",
  description: "Embed photos and galleries from Flickr links",
};
