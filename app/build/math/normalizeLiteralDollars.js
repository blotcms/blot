// Normalize literal dollar-delimited TeX into span.math.inline and span.math.display, the internal representation consumed before KaTeX rendering.
const escapeHtml = require("escape-html");

const SKIP_TAGS = ["script", "style", "code", "pre"];

function mathSpan(source, display) {
  const mode = display ? "display" : "inline";
  return (
    '<span class="math ' + mode + '">' + escapeHtml(source.trim()) + "</span>"
  );
}

function isEscaped(text, index) {
  let slashCount = 0;

  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
    slashCount += 1;
  }

  return slashCount % 2 === 1;
}

function isWhitespace(char) {
  return char === undefined || /\s/.test(char);
}

function isDigit(char) {
  return char !== undefined && /\d/.test(char);
}

function delimiterAt(text, index) {
  if (text[index] !== "$" || isEscaped(text, index)) return null;

  // A delimiter must comprise the entire run. In particular, do not treat a
  // portion of $$$ (or a longer run) as a supported one- or two-dollar
  // delimiter.
  if (text[index - 1] === "$") return null;

  let runLength = 1;
  while (text[index + runLength] === "$") runLength += 1;
  if (runLength > 2) return null;

  return runLength === 2 ? "$$" : "$";
}

function canOpen(text, index, delimiter) {
  const next = text[index + delimiter.length];

  if (delimiter === "$$") return next !== undefined;

  return next !== undefined && !isWhitespace(next);
}

function canClose(text, index, delimiter) {
  const previous = text[index - 1];
  const next = text[index + delimiter.length];

  if (delimiter === "$$") return previous !== undefined;

  return previous !== undefined && !isWhitespace(previous) && !isDigit(next);
}

function findClosingDelimiter(text, start, delimiter) {
  for (let i = start; i < text.length; i += 1) {
    if (delimiter === "$" && text[i] === "\n") return -1;

    if (text[i] === "$" && text[i - 1] !== "$" && !isEscaped(text, i)) {
      let runLength = 1;
      while (text[i + runLength] === "$") runLength += 1;
      if (runLength > 2) return -1;
    }

    if (delimiterAt(text, i) !== delimiter) continue;
    if (!canClose(text, i, delimiter)) continue;

    const source = text.slice(start, i);

    // Multiline display math is supported when both delimiters occupy their
    // own lines. This prevents otherwise unrelated dollars on separate lines
    // from being paired merely because they share a text node.
    if (
      source.includes("\n") &&
      (delimiter !== "$$" || !/^\s*\n[\s\S]*\n\s*$/.test(source))
    ) {
      return -1;
    }

    return i;
  }

  return -1;
}

function isDisplayMath(source, before, after, delimiter) {
  if (delimiter !== "$$") return false;

  return (
    /^\s*\n/.test(source) || (/^\s*$/.test(before) && /^\s*$/.test(after || ""))
  );
}

function pushTextToken(tokens, value) {
  if (!value) return;

  const previous = tokens[tokens.length - 1];

  if (previous && previous.type === "text") {
    previous.value += value;
    return;
  }

  tokens.push({ type: "text", value });
}

function tokenizeDollarMath(text) {
  if (!text || text.indexOf("$") === -1) return [{ type: "text", value: text }];

  const tokens = [];
  let cursor = 0;
  let textStart = 0;

  while (cursor < text.length) {
    const delimiter = delimiterAt(text, cursor);

    if (!delimiter || !canOpen(text, cursor, delimiter)) {
      cursor += 1;
      continue;
    }

    const sourceStart = cursor + delimiter.length;
    const close = findClosingDelimiter(text, sourceStart, delimiter);

    if (close === -1) {
      cursor += delimiter.length;
      continue;
    }

    const source = text.slice(sourceStart, close);

    if (source.trim() === "") {
      cursor += delimiter.length;
      continue;
    }

    const afterStart = close + delimiter.length;
    const before = text.slice(textStart, cursor);
    const after = text.slice(afterStart);

    pushTextToken(tokens, before);
    tokens.push({
      type: "math",
      value: source,
      display: isDisplayMath(source, before, after, delimiter),
    });

    cursor = afterStart;
    textStart = cursor;
  }

  pushTextToken(tokens, text.slice(textStart));

  if (tokens.length === 0) return [{ type: "text", value: text }];

  return tokens;
}

function normalizeMathInText(text) {
  const tokens = tokenizeDollarMath(text);

  if (!tokens.some((token) => token.type === "math")) return text;

  return tokens
    .map((token) => {
      if (token.type === "math") return mathSpan(token.value, token.display);

      return escapeHtml(token.value);
    })
    .join("");
}

function canFlattenLinebreakParagraph(node) {
  if (!node || !node.children) return false;

  return node.children.every(
    (child) => child.type === "text" || child.name === "br"
  );
}

// Find display math without first flattening the paragraph. Flattening is
// tempting here, but it destroys every <br> in the paragraph even when the
// dollars do not form a display expression.
function displayMathRanges(node) {
  let text = "";
  const textNodes = [];

  node.children.forEach((child) => {
    if (child.type === "text") {
      textNodes.push({
        node: child,
        start: text.length,
        end: text.length + child.data.length,
      });
      text += child.data;
    } else if (child.name === "br") {
      text += "\n";
    }
  });

  const lines = [];
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || text[i] === "\n") {
      lines.push({ start, end: i, value: text.slice(start, i) });
      start = i + 1;
    }
  }

  const ranges = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*\$\$\s*$/.test(lines[i].value)) continue;

    for (let close = i + 1; close < lines.length; close += 1) {
      if (!/^\s*\$\$\s*$/.test(lines[close].value)) continue;

      const source = text.slice(lines[i].end + 1, lines[close].start);
      if (source.trim()) {
        ranges.push({
          start: lines[i].start,
          end: lines[close].end,
          source,
          textNodes,
        });
        i = close;
      }
      break;
    }
  }

  return ranges;
}

function replaceDisplayRange($, range) {
  const affected = range.textNodes.filter(
    (entry) => entry.end > range.start && entry.start < range.end
  );
  if (!affected.length) return;

  const first = affected[0];
  // The opening delimiter occupies its whole visual line, so replacing its
  // text node cannot consume any surrounding content.
  $(first.node).replaceWith(mathSpan(range.source, true));

  affected.slice(1).forEach((entry) => {
    const from = Math.max(range.start, entry.start) - entry.start;
    const to = Math.min(range.end, entry.end) - entry.start;
    entry.node.data =
      entry.node.data.slice(0, from) + entry.node.data.slice(to);
  });
}

function eachTextNode(node, cb) {
  if (!node || !node.children) return;

  node.children.slice().forEach((child) => {
    if (child.type === "text") {
      cb(child);
      return;
    }

    if (SKIP_TAGS.includes(child.name)) return;

    eachTextNode(child, cb);
  });
}

// Elements named name, in document order. Cheerio's own $("p") and $("body")
// are quadratic in the number of siblings when the document is a fragment (a
// flat run of top-level blocks): about 14 ms for 2000 paragraphs, 400 ms for
// 10000. Walking the tree is linear and finds the same nodes.
function elementsNamed(root, name, firstOnly) {
  const found = [];
  const stack = [root];

  while (stack.length) {
    const node = stack.pop();
    if (node.type === "tag" && node.name === name) {
      found.push(node);
      if (firstOnly) return found;
    }
    const children = node.children;
    if (!children) continue;
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }

  return found;
}

function normalizeLiteralDollarMath($) {
  elementsNamed($.root()[0], "p").forEach(function (node) {
    const $p = $(node);
    if ($p.html().indexOf("$$") === -1 || $p.find("br").length === 0) return;
    if (!canFlattenLinebreakParagraph(node)) return;

    displayMathRanges(node)
      .reverse()
      .forEach((range) => replaceDisplayRange($, range));
  });

  const rootNode = elementsNamed($.root()[0], "body", true)[0] || $.root()[0];

  eachTextNode(rootNode, (textNode) => {
    const converted = normalizeMathInText(textNode.data);

    if (converted !== textNode.data) {
      $(textNode).replaceWith(converted);
    }
  });
}

module.exports = {
  normalizeLiteralDollarMath,
  normalizeMathInText,
  tokenizeDollarMath,
};
