// Page- or feature-specific CSS kept out of the global docs bundle.
// These files are still copied to views-built and loaded only when needed:
// tex.css via documentation/tools/tex.js, the others via head.html's
// {{#selected.*}} conditionals. Centralizing the paths here means renaming
// or removing one of these files only requires updating this one list.
const TEX_STYLESHEET_PATH = "/css/tex.css";

module.exports = {
  TEX_STYLESHEET_PATH,
  DOCUMENTATION_BUNDLE_EXCLUDES: [
    TEX_STYLESHEET_PATH,
    "/questions/tagify.css",
    "/examples.css",
  ],
};
