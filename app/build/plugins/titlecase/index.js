const titlecase = require("helper/titlecase");

async function render($) {
  try {
    $("h1, h2, h3, h4, h5, h6").each(function findTextNodes(i, node) {
      $(node)
        .contents()
        .each((i, childNode) => {
          if (childNode.nodeType === 3) {
            $(childNode).replaceWith(titlecase(childNode.data));
          } else {
            findTextNodes(i, childNode);
          }
        });
    });
  } catch (e) {}
}

module.exports = {
  render,
  isDefault: false,
  category: "headings",
  title: "Titlecase",
  description: "Use title case for headings",
};
