var CleanCSS = require("clean-css");
var minimize = new CleanCSS();

const minifyCSS = (css) => {
  try {
    const result = minimize.minify(css || "").styles;
    if (!result) {
      throw new Error("Minification failed");
    }
    return result;
  } catch (e) {
    console.error("Error during minification:", e);
    return css;
  }
};

const esbuild = require("esbuild");

const minifyJS = async (output) => {
  try {
    const result = await esbuild.transform(output, {
      minify: true,
      target: "es6",
      loader: "js",
    });
    return result.code;
  } catch (error) {
    console.error("Error during minification:", error);
    return output;
  }
};

module.exports = {
  minifyCSS,
  minifyJS,
};
