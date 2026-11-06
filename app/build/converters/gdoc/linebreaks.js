const ELEMENT_TYPES = ["tag", "script", "style"];

function nextElement(node) {
  for (let n = node.next; n; n = n.next) {
    if (ELEMENT_TYPES.includes(n.type)) return n;
  }
  return null;
}

function isParagraphOrRule(node) {
  return node.name === "p" || node.name === "hr";
}

module.exports = function ($) {
  // Sort out line breaks
  // Google Docs uses empty <p> tags to represent line breaks
  // We want to convert these into <br> tags instead
  // But we also want to preserve multiple line breaks in a row
  // So we need to group consecutive <p> tags together and then
  // join them with <br> tags
  // Step 1: Collect all <p> nodes in order
  // Step 1: Collect all <p> nodes in order
  // Instead of just pNodes, grab all <p> and <hr> in order:
  const nodes = $("p, hr").toArray();

  let currGroup = [];
  let prevNode = null;
  let emptyCount = 0;

  const flushCurrentGroup = () => {
    if (currGroup.length === 0) return null;

    const firstP = currGroup[0];
    const lines = currGroup.map((n) => $(n).html().trim());
    $(firstP).html(lines.join("<br>"));
    for (let j = 1; j < currGroup.length; j++) {
      $(currGroup[j]).remove();
    }
    currGroup = [];

    return firstP;
  };

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const tag = node.tagName ? node.tagName.toLowerCase() : node.name;

    if (tag === "p") {
      if (currGroup.length > 0) {
        const lastInGroup = currGroup.at(-1);

        // Flush unless the next element sibling is this p/hr, walking
        // siblings directly: nextAll/nextUntil build the whole sibling list
        // for every paragraph, which is quadratic in a long document
        if (nextElement(lastInGroup) !== node) {
          // the elements between this group and the next p/hr, found before
          // the flush removes the group's later paragraphs
          let between = null;
          for (
            let sibling = nextElement(lastInGroup);
            sibling && !isParagraphOrRule(sibling);
            sibling = nextElement(sibling)
          ) {
            between = sibling;
          }
          const flushedFirst = flushCurrentGroup();
          prevNode = between || flushedFirst;
          emptyCount = 0;
        }
      }

      const inner = $(node).html().trim();

      // Is this an empty line?
      // Note: empty spans are already cleaned up by cleanupSpans()
      if (inner === "") {
        emptyCount++;
        // Always remove the empty <p>
        $(node).remove();

        // If we have a current group, close it
        const flushedFirst = flushCurrentGroup();
        if (flushedFirst) {
          prevNode = flushedFirst;
        }
      } else {
        // Before starting a new group, insert <br> for extra empty lines (if any)
        if (
          emptyCount > 1 &&
          prevNode &&
          prevNode.tagName !== "HR" &&
          prevNode.name !== "hr"
        ) {
          for (let k = 1; k < emptyCount; k++) {
            $(prevNode).after("<br>");
            prevNode = $(prevNode).next()[0];
          }
        }
        emptyCount = 0; // Reset empty count

        currGroup.push(node);
        prevNode = node;
      }
    } else if (tag === "hr") {
      // If we have a current group, close it (no <br> before <hr>)
      flushCurrentGroup();
      emptyCount = 0; // Reset empty count after <hr>
      prevNode = node; // Update prevNode to <hr>
    }
  }

  // Handle any trailing group
  flushCurrentGroup();
};
