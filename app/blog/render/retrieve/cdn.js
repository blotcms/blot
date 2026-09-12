const config = require("config");
const generateCdnUrl = require("models/template/util/generateCdnUrl");
const asRetriever = require("../../lib/asRetriever");

module.exports = asRetriever(function (req, res) {
  return function () {
    const manifest = (req && req.template && req.template.cdn) || {};
    const templateID = req.template && req.template.id;

    // Section: {{#cdn}}/path/to/file{{/cdn}}
    const renderCdn = function (text, render) {
      try {
        // Skip CDN URLs for preview subdomains
        if (req.preview) {
          return typeof render === "function" ? render(text) : text;
        }

        let rendered = typeof render === "function" ? render(text) : text;
        if (!rendered || !String(rendered).trim()) return "";

        const renderedNormalized = String(rendered).trim().replace(/^\//, "");

        if (
          templateID &&
          Object.prototype.hasOwnProperty.call(manifest, renderedNormalized)
        ) {
          return generateCdnUrl(
            renderedNormalized,
            manifest[renderedNormalized]
          );
        }

        return rendered;
      } catch (e) {
        return text;
      }
    };

    // Interpolation: {{cdn}}
    renderCdn.toString = function () {
      return config.cdn.origin;
    };

    return renderCdn;
  };
});
