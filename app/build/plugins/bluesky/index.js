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

function render($, callback) {

  each(
    $,
    "a",
    function (el, next) {
      var href, host, text, id;

      try {
        href = $(el).attr("href");
        text = $(el).text();
        host = Url.parse(href).host;
      } catch (e) {
        return next();
      }

      // Ensure we managed to extract everything from the url
      if (!href || !text || !host) return next();

      // Look for bare links
      if (href !== text) return next();

      // which point to a post on bluesky
      if (host !== "bsky.app") return next();

      var params = {
        url: href,
        format: "json",
        maxwidth: 600,
      };

      var oembedUrl =
        "https://embed.bsky.app/oembed?" +
        new URLSearchParams(params).toString();

      fetch(oembedUrl)
        .then((res) => res.json())
        .then((data) => {
          if (!data || !data.html) return next();

          var html = data.html;

          $(el).replaceWith(html);
          next();
        })
        .catch(() => {
          return next();
        });
    },
    function () {
      callback();
    }
  );
}

module.exports = {
  render: render,
  category: "embeds",
  title: "Bluesky",
  description: "Embed posts from Bluesky links",
};
