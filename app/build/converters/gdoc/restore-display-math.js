function lineText(nodes) {
  if (!nodes.every((node) => node.type === "text")) return null;
  return nodes.map((node) => node.data || "").join("");
}

// Google Docs exports each visual line as a paragraph. linebreaks.js later joins
// adjacent paragraphs with <br>, so a display equation can arrive here as three
// lines in a larger paragraph: $$, TeX, $$. Split just that line-bounded range
// back into its own paragraph for the generic dollar-math normalizer.
function restoreDisplayMath($, paragraph) {
  const children = paragraph.children || [];
  const lines = [];
  let start = 0;

  for (let i = 0; i <= children.length; i += 1) {
    if (i === children.length || children[i].name === "br") {
      lines.push({ start, end: i, nodes: children.slice(start, i) });
      start = i + 1;
    }
  }

  for (let open = 0; open < lines.length; open += 1) {
    if ((lineText(lines[open].nodes) || "").trim() !== "$$") continue;

    for (let close = open + 1; close < lines.length; close += 1) {
      if ((lineText(lines[close].nodes) || "").trim() !== "$$") continue;

      const sourceLines = lines
        .slice(open + 1, close)
        .map((line) => lineText(line.nodes));

      // Do not span formatting, links, or other structural elements.
      if (sourceLines.some((line) => line === null)) break;

      const source = sourceLines.join("\n");
      if (!source.trim()) break;

      const $paragraph = $(paragraph);
      const beforeNodes = children.slice(0, Math.max(0, lines[open].start - 1));
      const afterNodes = children.slice(
        Math.min(children.length, lines[close].end + 1)
      );
      const replacements = [];

      if (beforeNodes.length) {
        replacements.push($paragraph.clone().empty().append(beforeNodes));
      }

      replacements.push(
        $paragraph
          .clone()
          .empty()
          .text("$$\n" + source + "\n$$")
      );

      if (afterNodes.length) {
        replacements.push($paragraph.clone().empty().append(afterNodes));
      }

      replacements.forEach(($replacement) => $paragraph.before($replacement));
      $paragraph.remove();

      if (afterNodes.length) {
        restoreDisplayMath($, replacements[replacements.length - 1][0]);
      }
      return;
    }
  }
}

module.exports = function ($) {
  $("p").each(function () {
    restoreDisplayMath($, this);
  });
};
