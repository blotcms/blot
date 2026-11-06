const { build } = require("esbuild");
const { join } = require("path");
const clfdate = require("helper/clfdate");

module.exports =
  ({ source, destination }) =>
  async () => {
    await build({
      entryPoints: [join(source, "js/documentation.js")],
      bundle: true,
      minify: true,
      target: "es6",
      outfile: join(destination, "documentation.min.js"),
    });

    console.log(clfdate(), "built documentation.min.js");

    await build({
      entryPoints: [join(source, "js/dashboard.js")],
      bundle: true,
      minify: true,
      target: "es6",
      outfile: join(destination, "dashboard.min.js"),
    });

    console.log(clfdate(), "built dashboard.min.js");

    await build({
      entryPoints: [join(source, "dashboard/template/js/index.js")],
      bundle: true,
      minify: true,
      target: "es6",
      outfile: join(destination, "template-editor.min.js"),
    });

    console.log(clfdate(), "built template-editor.min.js");

    await build({
      entryPoints: [
        join(source, "dashboard/template/js/source-code-editor.js"),
      ],
      bundle: true,
      minify: true,
      target: "es6",
      outfile: join(destination, "js/template-source-editor.min.js"),
    });

    console.log(clfdate(), "built template-source-editor.min.js");
  };
