const asRetriever = require("../../lib/asRetriever");

module.exports = asRetriever(function (req, res) {
  return function () {
    return function (text, render) {
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
