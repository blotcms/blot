var Url = require("url");

async function render($, options) {
  // Links with these hosts
  // are not external.
  var ignore;

  try {
    // sometimes url parse returns null for
    // some reason with an apparently valid domain
    // not sure yet why but should fix this.
    // in the meantime, I pass in the domain as well
    // as the normalized domain
    ignore = [
      Url.parse(options.domain).host,
      Url.parse(options.baseURL).host,
      options.domain,
    ];
  } catch (e) {
    return;
  }

  $("a").each(function () {
    try {
      var href = $(this).attr("href");
      var host = Url.parse(href).host;

      if (host && ignore.indexOf(host) === -1) $(this).attr("target", "_blank");
    } catch (e) {}
  });
}

module.exports = {
  render,
  isDefault: false,
  category: "links",
  description: "Open external links in a new tab",
};
