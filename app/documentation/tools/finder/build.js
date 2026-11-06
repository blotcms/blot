var fs = require("fs-extra");
var DataURI = require("datauri");
var CleanCSS = require("clean-css");

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
    const datauri = await DataURI(__dirname + "/images/" + name);

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
