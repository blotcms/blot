var url = require("url");
var eachEl = require("build/plugins/eachEl");
var { report } = require("build/flags");

var Players = {
  bandcamp: {
    module: require("./bandcamp"),
    // bandcamp.com or an <artist>.bandcamp.com subdomain only - the old
    // /.bandcamp.com$/ also matched notbandcamp.com / evil-bandcamp.com.
    // bandcamp.js re-checks this before it fetches anything.
    regex: /^([a-z0-9-]+\.)*bandcamp\.com$/i,
  },
  youtube: {
    module: require("./youtube"),
    regex: /((^|^m.|^www.)youtube.com$)|(^youtu.be$)/m,
  },
  vimeo: {
    module: require("./vimeo"),
    regex: /(^|^www.)vimeo.com$/m,
  },
};

async function render($) {
  // be wary of the effects of typeset's
  // auto soft hyphen insertion. this fucks
  // with the text of alink but not its href
  // we'd need to normalize both the href
  // and link text to remove space chars before
  // proceding. also url parse href gets screwy too.
  await eachEl($, "a", async function (el) {
    var href = $(el).attr("href");
    var hostname;

    // Only replace links where URL
    // matches link text exactly
    if (href !== $(el).text()) return;

    try {
      hostname = url.parse(href).hostname;
    } catch (e) {
      return;
    }

    if (!hostname) return;

    // See if we have a method for
    // retrieving a video from this host
    var module;

    Object.values(Players).forEach((site) => {
      var test = hostname.match(site.regex);
      if (test != null && test.length > 0) {
        module = site.module;
      }
    });

    if (!module) return;

    // fetchPlayer is a method unique to each
    // video streaming site which takes the URL
    // and returns HTML for player if valid video
    var template;

    try {
      template = await module(href);
    } catch (err) {
      // The link stays in the post, so it still works; the flag says the
      // video wasn't embedded
      report({ code: "EMBED_FAILED", targets: [href] });
      return;
    }

    if (!template) return;

    insertPlayer(el, template, href);
  });

  // This function takes the HTML code for a particular
  // video player and replaces the link element with that code
  function insertPlayer(el, template, href) {
    // If the link has siblings and is inside
    // a p tag then replace the p tag with the
    // iframe instead of inserting the iframe
    // inside the p tag, which is illegal.
    if (
      $(el).parent().length &&
      $(el).parent()[0].name === "p" &&
      $(el).parent().text() !== href
    ) {
      $(el).parent().after(template);
      $(el).replaceWith("");

      // If the link has a parent which doesn't
      // have other child nodes, then replace the
      // entire parent with the template
    } else if ($(el).parent().length) {
      $(el).parent().replaceWith(template);

      // if the link is the rootnode (rare but possible)
      // then simply replace the link with the iframe...
    } else {
      $(el).replaceWith(template);
    }
  }
}

module.exports = {
  render,
  category: "embeds",
  title: "Videos",
  description: "Embed videos or audio from media links",
};
