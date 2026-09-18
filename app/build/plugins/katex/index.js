// Render span.math.inline and span.math.display, the normalized internal representation for TeX emitted by converters, into KaTeX HTML.
const katex = require("katex");
const HARD_BREAK_SENTINEL = require("../../math/hardBreakSentinel");

const SKIP_TAGS = ["script", "style", "code", "pre"];
const BLOCK_BOUNDARY_TAGS = [
  "p",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "td",
  "th",
  "dt",
  "dd",
];
const BLOCK_BOUNDARY_SELECTOR = BLOCK_BOUNDARY_TAGS.join(",");

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderTex(source, display) {
  const original = source;

  if (!source) return "";

  try {
    return katex.renderToString(source.trim(), { displayMode: display });
  } catch (error) {
    const delimiter = display ? "$$" : "$";
    return delimiter + escapeHtml(original) + delimiter;
  }
}

// A <br> that loosenDisplayMath inserted to isolate display math on its own
// source line carries the sentinel in the text node on the far side of it
// (see build/math/loosenDisplayMath.js). A <br> the author actually wrote
// has no such marker, and still disqualifies the math from display
// rendering, as before.
function isOwnLineBreak(br, direction) {
  const neighbour = direction === "prev" ? br.prev : br.next;
  return (
    neighbour &&
    neighbour.type === "text" &&
    (neighbour.data || "").indexOf(HARD_BREAK_SENTINEL) !== -1
  );
}

// Walk outward from a node, in one direction, looking for real content that
// shares its line with it. An author-written <br> marks mixed content, same
// as any other tag. A loosenDisplayMath <br> marks a line boundary instead:
// content beyond it doesn't count. Running out of siblings at one level
// moves the search up to that ancestor's position in its own parent,
// stopping for good at a block-boundary tag (p, li, td, ...).
function hasContentOnSameLine(node, direction) {
  while (node) {
    const parent = node.parent;
    if (!parent) return false;

    let sibling = direction === "prev" ? node.prev : node.next;

    while (sibling) {
      if (sibling.type === "tag" && sibling.name === "br") {
        return !isOwnLineBreak(sibling, direction);
      }
      if (sibling.type === "text") {
        const text = (sibling.data || "").split(HARD_BREAK_SENTINEL).join("");
        if (/\S/.test(text)) return true;
      } else if (sibling.type === "tag") {
        return true;
      }
      sibling = direction === "prev" ? sibling.prev : sibling.next;
    }

    if (parent.type === "tag" && BLOCK_BOUNDARY_TAGS.includes(parent.name)) {
      return false;
    }

    node = parent;
  }

  return false;
}

// Display math sharing its line with other content should render inline so
// it doesn't break out of the line. Math set off on its own line - whether
// by a blank line (a separate paragraph) or a hard line break around it -
// keeps its display rendering even when other text shares the same block.
function isMixedBlockDisplay($span) {
  const node = $span[0];

  return (
    hasContentOnSameLine(node, "prev") || hasContentOnSameLine(node, "next")
  );
}

function stripHardBreakSentinels($) {
  $("*")
    .addBack()
    .contents()
    .each(function () {
      if (
        this.type === "text" &&
        this.data &&
        this.data.indexOf(HARD_BREAK_SENTINEL) !== -1
      ) {
        this.data = this.data.split(HARD_BREAK_SENTINEL).join("");
      }
    });
}

function renderPandocMath($) {
  $("span.math.inline, span.math.display").each(function () {
    const $span = $(this);
    if ($span.closest(SKIP_TAGS.join(",")).length) return;

    let display = $span.hasClass("display");
    if (display && isMixedBlockDisplay($span)) {
      display = false;
    }

    const source = $span.text();

    $span.replaceWith(renderTex(source, display));
  });
}

function render($, callback) {
  if (!$ || typeof $ !== "function") return callback(null);

  renderPandocMath($);
  stripHardBreakSentinels($);

  callback(null);
}

module.exports = {
  category: "codemath",
  title: "Math",
  description: "Enable TeX equations",
  render,
};
