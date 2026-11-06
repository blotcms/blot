const withPluginCallback = require("../withPluginCallback");

async function render($) {
  ["audio", "video"].forEach((tag) => {
    $(tag).each(function () {
      const el = $(this);
      if (el.attr("preload") !== undefined) return;

      // The HTML standard defaults <audio>/<video> preload to "auto", which
      // allows browsers to fetch the entire media file up front. Setting the
      // attribute to "metadata" keeps the initial request limited to headers
      // so players render quickly without downloading everything eagerly.
      // https://html.spec.whatwg.org/multipage/media.html#attr-media-preload
      el.attr("preload", "metadata");
    });
  });
}

module.exports = {
  render: withPluginCallback(render),
  description:
    'Ensures embedded <audio> and <video> elements default to preload="metadata"',
  category: "Performance",
  isDefault: true,
};
