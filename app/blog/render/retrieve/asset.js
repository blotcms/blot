const asRetriever = require("../../lib/asRetriever");
const folderManifestUrl = require("../folderManifestUrl");
const { folderTarget } = require("models/template/util/resolveFolderLinks");

module.exports = asRetriever(function (req, res) {
  return function () {
    return function (text, render) {
      // A file in the blog's folder goes straight to the CDN: the template's
      // manifest resolves literal {{#asset}} paths (see updateCdnManifest).
      // Anything else - a template view such as style.css, or a file which
      // doesn't exist - keeps the cache-busted URL on the blog's own host.
      const rendered = render(text).trim();
      const target = folderTarget(
        rendered.charAt(0) === "/" ? rendered : "/" + rendered,
        []
      );
      const cdnUrl = target && folderManifestUrl(req, target);

      if (cdnUrl) return cdnUrl;

      let extension;

      if (text.lastIndexOf(".") > -1 && text.lastIndexOf(".") < text.length + 2)
        extension = text.slice(text.lastIndexOf("."));

      if (!text.startsWith("/")) text = "/" + text;

      if (extension)
        text = text + "?cache={{cacheID}}&amp;extension=" + extension;

      return render(text);
    };
  };
});
