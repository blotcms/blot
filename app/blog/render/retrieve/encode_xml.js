// This function accepts some HTML makes it suitable for
// inclusion in a CDATA-fenced description tag for an RSS
// feed item. It resolves relative URLs to make the result
// more portable. It should help produce valid feeds.
const absolute_urls = require("./absolute_urls").absolute_urls;
const cheerio = require("cheerio");
const asRetriever = require("../../lib/asRetriever");

// Removes everything forbidden by XML 1.0 specifications,
// plus the unicode replacement character U+FFFD
function removeXMLInvalidChars(string) {
  const regex =
    /((?:[\0-\x08\x0B\f\x0E-\x1F\uFFFD\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]))/g;
  return string.replace(regex, "");
}

module.exports = asRetriever(function (req, res) {
  return function () {
    return function (text, render) {
      let xml;
      let $;

      text = render(text);

      try {
        $ = cheerio.load(
          text,
          {
            decodeEntities: false,
          },
          false
        );
        $ = absolute_urls(req.protocol + "://" + req.get("host"), $);
        $("script").remove();
        xml = $.html();
        xml = removeXMLInvalidChars(xml);
      } catch (e) {
        console.log(e);
      }

      return xml || text;
    };
  };
});
