// use npm package 'clean-css' to minify css
const CleanCSS = require("clean-css");
const { join } = require("path");
const fs = require("fs-extra");
const recursiveReadDir = require("helper/recursiveReadDirSync");
const prettySize = require("helper/prettySize");
const clfdate = require("helper/clfdate");

const buildFinderCSS = require("../tools/finder/build.js");
const { DOCUMENTATION_BUNDLE_EXCLUDES } = require("./pageSpecificAssets");

const isExcludedFromDocumentationBundle = (filePath) =>
  DOCUMENTATION_BUNDLE_EXCLUDES.some((suffix) => filePath.endsWith(suffix));

module.exports = ({ source, destination }) => async () => {
  const cssFilePaths = recursiveReadDir(source).filter((i) =>
    i.endsWith(".css")
  );

  const dashboardFiles = cssFilePaths.filter((i) => i.includes("/dashboard/"));
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

  const dashboardCSS = await mergeCSSFiles(dashboardFiles);
  await fs.writeFile(
    join(destination, "dashboard.min.css"),
    dashboardCSS.styles
  );
  console.log(
    clfdate(),
    "dashboard.min.css built: ",
    prettySize(dashboardCSS.stats.minifiedSize / 1024)
  );
};

const mergeCSSFiles = async (files) => {
  const cssContents = await Promise.all(
    files.map((file) => fs.readFile(file, "utf-8"))
  );

  // pull in callouts.css from app/build/plugins/callouts
  const calloutsCSS = await fs.readFile(
    join(__dirname, "../../../app/build/plugins/callouts/public.css"),
    "utf-8"
  );

  const mergedCSS = cssContents.join("\n\n") + "\n" + calloutsCSS;

  const minifiedCSS = new CleanCSS({ level: 2 }).minify(mergedCSS);

  return minifiedCSS;
};
