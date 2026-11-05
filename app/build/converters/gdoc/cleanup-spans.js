const BLOCK_ELEMENTS = [
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "ul",
  "ol",
  "li",
  "hr",
  "table",
  "thead",
  "tbody",
  "tr",
  "td",
  "th",
  "section",
  "article",
  "header",
  "footer",
  "nav",
  "aside",
  "dl",
  "dt",
  "dd",
  "pre",
  "figure",
  "figcaption",
  "address",
  "fieldset",
  "legend",
];

module.exports = ($) => {
  const blockSelector = BLOCK_ELEMENTS.join(", ");

  // Unwrapping a span moves its contents up, so whether a span contains a
  // block element never changes while we work: find every span that does with
  // one selector and a walk up from each block, rather than running a
  // selector over each span's subtree.
  const containsBlock = new Set();
  $(blockSelector).each((i, block) => {
    for (let node = block.parent; node; node = node.parent) {
      if (node.name === "span") {
        if (containsBlock.has(node)) break;
        containsBlock.add(node);
      }
    }
  });

  const spans = $("span").get().reverse();

  spans.forEach((span) => {
    const $span = $(span);

    // Skip spans that contain block elements
    if (containsBlock.has(span)) {
      return;
    }

    // Check if span has important attributes that should be preserved
    const attrs = $span[0].attribs || {};
    const hasImportantAttrs = Object.keys(attrs).some((attr) => {
      // style is already removed before this function runs
      // preserve id, class, data-*, aria-*, and role attributes
      return (
        attr === "id" ||
        attr === "class" ||
        attr === "role" ||
        attr.startsWith("data-") ||
        attr.startsWith("aria-")
      );
    });

    if (hasImportantAttrs) {
      return;
    }

    // Unwrap span, preserving its contents (if any)
    const contents = $span.contents();
    if (contents.length > 0) {
      $span.replaceWith(contents);
    } else {
      $span.remove(); // Explicitly remove empty spans
    }
  });

  return $;
};
