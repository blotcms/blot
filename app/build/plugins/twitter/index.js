const each = require("../eachEl");
const Url = require("url");
const fetch = require("node-fetch");

function render($, callback) {
  each(
    $,
    "a",
    function (el, next) {
      var href, host, text;

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

      // which point to a post on flickr, include all flickr hosts including www. subdomain
      if (!/^(www\.)?(twitter\.com|x\.com)$/.test(host)) return next();

      var params = {
        url: href,
        format: "json",
      };

      var oembedUrl =
        "https://publish.twitter.com/oembed?" +
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
  title: "Tweets",
  description: "Embed posts from Twitter links",
};
