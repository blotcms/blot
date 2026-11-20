// A template's README (README, readme.txt, README.md, in any case) documents
// the template for whoever edits it. It is stored with the other files, so
// it shows in the template editor, in a template folder and in a fork, but it
// is never a page: it has no URL, is never rendered and can't be a partial.
const README = /^readme(\.(md|txt))?$/i;

module.exports = function isReadme(name) {
  return typeof name === "string" && README.test(name);
};
