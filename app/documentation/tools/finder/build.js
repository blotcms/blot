var fs = require("fs-extra");
var path = require("path");
var CleanCSS = require("clean-css");

const MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

module.exports = async function () {
  var images = await fs.readdir(__dirname + "/images");
  var styles = await fs.readdir(__dirname + "/css");
  var css = "";

  for (const name of styles) {
    if (name.indexOf(".css") === -1) continue;
    css += await fs.readFile(__dirname + "/css/" + name, "utf-8");
  }

  for (const name of images) {
    if (css.indexOf(name) === -1) continue;
    const type = MIME_TYPES[path.extname(name).toLowerCase()];
    if (!type) throw new Error("No MIME type for " + name);
    const data = await fs.readFile(__dirname + "/images/" + name, "base64");
    const datauri = "data:" + type + ";base64," + data;

    css = css.split(name).join(datauri);
  }

  css = new CleanCSS().minify(css).styles;

  return css;
};

if (require.main === module) {
  async function main() {
    const css = await module.exports();
    fs.outputFileSync(__dirname + "/build.css", css);
  }
  main();
}
