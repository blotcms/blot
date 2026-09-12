/*

This function accepts some HTML and will resolve any relative
URLs against the host for the particular request. This is only
used in a site's RSS feed and should eventually be deprecated,
probably, since it's expensive to do this at render time.

For example, assuming the request is served from 'example.com'
over HTTPS, this lambda will transform:
<img src="/abc.png">    -->   <img src="https://example.com/abc.png">
It checks anything with an 'src' or 'href' attribute.

Use it like this:
{{#absolute_urls}}
  {{{entry.html}}}
{{/absolute_urls}}

*/
const cheerio = require("cheerio");
const debug = require("debug")("blot:render:absolute_urls");
const asRetriever = require("../../lib/asRetriever");

function absolute_urls(base, $) {
  try {
    $("[href], [src]").each(function () {
      const href = $(this).attr("href");
      const src = $(this).attr("src");

      // This is a little naive but whatever.
      // For example, what about protcol-less
      // urls like //example.com/site.jpg
      if (href && href[0] === "/") {
        $(this).attr("href", base + href);
      }

      if (src && src[0] === "/") {
        $(this).attr("src", base + src);
      }
    });
  } catch (e) {
    debug(e);
  }

  return $;
}

module.exports = asRetriever(function (req, res) {
  return function () {
    return function (text, render) {
      const base = req.protocol + "://" + req.get("host");

      text = render(text);

      let $ = cheerio.load(text, null, false);

      text = absolute_urls(base, $);
      text = $.html();

      return text;
    };
  };
});

// We also want to use this function in encode_xml
// so we export it without the callback wrapper.
module.exports.absolute_urls = absolute_urls;
module.exports.absoluteURLs = absolute_urls;
