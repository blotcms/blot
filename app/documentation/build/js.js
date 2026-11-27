const { build } = require("esbuild");
const fs = require("fs-extra");
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

    // Middle truncation runs inline at the end of each dashboard page, not in
    // the deferred bundle, so the first paint already shows the shortened
    // text. It goes in as a partial (partials/footer.html includes it).
    const truncate = await build({
      entryPoints: [join(source, "js/truncate.js")],
      bundle: true,
      minify: true,
      target: "es6",
      write: false,
    });
    const truncateScript = truncate.outputFiles[0].text.trim();
    // Mustache would read "{{" as a tag and "</script" would end the element
    if (/\{\{|<\/script/i.test(truncateScript)) {
      throw new Error(
        "truncate.js can't be inlined: its output has {{ or </script"
      );
    }
    await fs.outputFile(
      join(destination, "partials/truncate-script.html"),
      "<script>" + truncateScript + "</script>\n"
    );

    console.log(clfdate(), "built partials/truncate-script.html");

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
