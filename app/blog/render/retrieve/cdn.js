const config = require("config");
const generateCdnUrl = require("models/template/util/generateCdnUrl");
const BLOT_CDN_TOKEN = require("../replaceFolderLinks/cdnToken");
const { folderUrl } = require("../replaceFolderLinks/folderFile");
const { pathPartOf } = require("../replaceFolderLinks/shared");
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
          const entry = manifest[renderedNormalized];

          // A rendered view: the manifest value is its content hash
          if (typeof entry === "string") {
            return generateCdnUrl(renderedNormalized, entry);
          }

          // A file in the blog's folder (see updateCdnManifest): the entry is
          // { path, version }, path being the file's real, case-corrected
          // path (without any ?query or #hash, which are kept from the link).
          // Reserved global paths such as /fonts have no version. The
          // %%BLOT_CDN%% token is swapped for the real origin once the page
          // has rendered (blog/render/middleware.js).
          if (entry && typeof entry === "object" && typeof entry.path === "string") {
            const suffix = renderedNormalized.slice(
              pathPartOf(renderedNormalized).length
            );

            if (!entry.version) return BLOT_CDN_TOKEN + entry.path + suffix;

            return folderUrl(req.blog.id, entry.path, entry.version, suffix);
          }
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
