/* from bluesky docs:

oEmbed Endpoint

The official oEmbed endpoint for Bluesky posts is https://embed.bsky.app/oembed, which accepts the following HTTP GET query parameters:

    url (required): bsky.app or AT-URI pointing to a post
    format (optional): json is the default and only supported format
    maxwidth (optional, integer): range is 220 to 600; default is 600
    maxheight (optional, integer): part of oEmbed specification, but not used for Bluesky post embeds

The rendered height of posts is not known until rendered, so the maxheight is ignored and the height field in the response JSON is always null. This follows the precedent of Twitter tweet embeds.

The oEmebd response contains roughly the same HTML snippet as found at embed.bsky.app, with the same public content policy mentioned above.

The HTTP URL patterns which the oEmbed endpoint supports are:

    https://bsky.app/profile/:user/post/:id: post embeds

You can learn more about oEmbed at https://oembed.com. Bluesky is a registered provider, included in the JSON directory at https://oembed.com/providers.json.

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

    // which point to a post on bluesky
    if (host !== "bsky.app") return;

    var params = {
      url: href,
      format: "json",
      maxwidth: 600,
    };

    var oembedUrl =
      "https://embed.bsky.app/oembed?" + new URLSearchParams(params).toString();

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
  title: "Bluesky",
  description: "Embed posts from Bluesky links",
};
