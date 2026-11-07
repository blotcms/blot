// use npm package 'clean-css' to minify css
const CleanCSS = require("clean-css");
const { join } = require("path");
const fs = require("fs-extra");
const recursiveReadDir = require("helper/recursiveReadDirSync");
const prettySize = require("helper/prettySize");
const clfdate = require("helper/clfdate");

const buildFinderCSS = require("../tools/finder/build.js");
const { DOCUMENTATION_BUNDLE_EXCLUDES } = require("./pageSpecificAssets");

// Shared with the documentation bundle, in this order, ahead of the
// dashboard's own CSS
const DASHBOARD_SHARED_FILES = [
  "css/base.css",
  "css/authenticate.css",
  "css/buttons.css",
  "css/hljs.css",
  "css/icons.css",
  "css/inputs.css",
  "css/path.css",
  "css/steps.css",
  "css/truncate.css",
  "partials/breadcrumbs.css",
  "partials/footer.css",
  "partials/header.css",
];

// Only the template editor's pages use these
const isTemplateEditorFile = (filePath) =>
  /\/dashboard\/template\/(controls|css\/(codemirror-theme|editor|presets))/.test(
    filePath
  );

const isExcludedFromDocumentationBundle = (filePath) =>
  DOCUMENTATION_BUNDLE_EXCLUDES.some((suffix) => filePath.endsWith(suffix));

module.exports =
  ({ source, destination }) =>
  async () => {
    const cssFilePaths = recursiveReadDir(source).filter((i) =>
      i.endsWith(".css")
    );

    const dashboardFiles = cssFilePaths.filter((i) =>
      i.includes("/dashboard/")
    );

    // CodeMirror's stylesheet comes from npm and goes first, so Blot's
    // overrides in dashboard/template/css/codemirror-theme.css win.
    const codeMirrorCSS = require.resolve("codemirror/lib/codemirror.css");
    const documentationFiles = cssFilePaths.filter(
      (i) =>
        !dashboardFiles.includes(i) && !isExcludedFromDocumentationBundle(i)
    );

    const documentationCSS = await mergeCSSFiles(documentationFiles);
    const finderCSS = await buildFinderCSS();
    const fullDocumentationCSS = documentationCSS.styles + "\n" + finderCSS;
    await fs.writeFile(
      join(destination, "documentation.min.css"),
      fullDocumentationCSS
    );
    console.log(
      clfdate(),
      "documentation.min.css built: ",
      prettySize(Buffer.byteLength(fullDocumentationCSS, "utf8") / 1024)
    );

    // Dashboard pages load dashboard.min.css alone: the shared base and
    // components from css/ and partials/, then the dashboard's own CSS.
    const sharedFiles = DASHBOARD_SHARED_FILES.map((file) =>
      join(source, file)
    );
    const editorFiles = dashboardFiles.filter(isTemplateEditorFile);
    const dashboardCSS = await mergeCSSFiles([
      ...sharedFiles,
      ...dashboardFiles.filter((i) => !isTemplateEditorFile(i)),
    ]);
    await fs.writeFile(
      join(destination, "dashboard.min.css"),
      dashboardCSS.styles
    );
    console.log(
      clfdate(),
      "dashboard.min.css built: ",
      prettySize(dashboardCSS.stats.minifiedSize / 1024)
    );

    // The template editor's pages also load template-editor.min.css
    const editorCSS = await mergeCSSFiles([codeMirrorCSS, ...editorFiles], {
      callouts: false,
    });
    await fs.writeFile(
      join(destination, "template-editor.min.css"),
      editorCSS.styles
    );
    console.log(
      clfdate(),
      "template-editor.min.css built: ",
      prettySize(editorCSS.stats.minifiedSize / 1024)
    );
  };

const mergeCSSFiles = async (files, { callouts = true } = {}) => {
  const cssContents = await Promise.all(
    files.map((file) => fs.readFile(file, "utf-8"))
  );

  // pull in callouts.css from app/build/plugins/callouts
  const calloutsCSS = await fs.readFile(
    join(__dirname, "../../../app/build/plugins/callouts/public.css"),
    "utf-8"
  );

  const mergedCSS =
    cssContents.join("\n\n") + (callouts ? "\n" + calloutsCSS : "");

  const minifiedCSS = new CleanCSS({ level: 2 }).minify(mergedCSS);

  return minifiedCSS;
};
