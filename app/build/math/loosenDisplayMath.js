// Pandoc joins soft line breaks inside a paragraph into a single space, so
// display math ($$...$$) that sits on its own source line - separated from
// surrounding prose by a single newline rather than a blank line - ends up
// sharing its paragraph with that prose. The katex plugin then renders it
// inline rather than as a display equation, so it doesn't break out of the
// line (see build/plugins/katex/index.js).
//
// Editors such as Obsidian and iA Writer commonly write display math this
// way, with the equation left inside its enclosing paragraph rather than
// split into its own paragraph. To honour that convention, insert explicit
// Markdown hard line breaks (a trailing backslash) immediately around any
// display math that occupies a whole source line by itself, so Pandoc emits
// a <br> that the katex plugin can use as a display boundary. Math that
// shares its line with other text (e.g. "text $$x$$ text") is left alone.
const SENTINEL = require("./hardBreakSentinel");

// Markdown fences (```/~~~) and Org's #+begin_src/#+begin_example blocks.
// Checking for both regardless of which converter is calling in is
// harmless - neither pattern means anything special to the other format.
const MD_FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const ORG_FENCE_START_RE = /^\s*#\+begin_(src|example)\b/i;
const ORG_FENCE_END_RE = /^\s*#\+end_(src|example)\b/i;

const BARE_DELIMITER_RE = /^\s*\$\$\s*$/;
const SINGLE_LINE_DISPLAY_RE = /^\s*\$\$(?:(?!\$\$)[\s\S])+\$\$\s*$/;

function isBlank(line) {
  return line === undefined || line.trim() === "";
}

// The sentinel marks the resulting <br> as one we inserted (as opposed to
// one the author wrote), so the katex plugin knows it delimits a whole line
// rather than disqualifying the math from display rendering.
function endsWithSentinelBreak(line, hardBreak) {
  return (
    line !== undefined &&
    line.slice(-hardBreak.length - SENTINEL.length) === SENTINEL + hardBreak
  );
}

function startsWithSentinel(line) {
  return line !== undefined && line.indexOf(SENTINEL) === 0;
}

function addHardBreakBefore(line, hardBreak) {
  if (endsWithSentinelBreak(line, hardBreak)) return line;
  return line.replace(/[ \t]+$/, "") + SENTINEL + hardBreak;
}

function addHardBreakAfter(line) {
  if (startsWithSentinel(line)) return line;
  return SENTINEL + line;
}

// Markdown's hard line break is a trailing "\", Org's is a trailing "\\".
function loosenDisplayMath(text, options) {
  const hardBreak = (options && options.hardBreak) || "\\";

  if (!text || text.indexOf("$$") === -1) return text;

  const lines = text.split("\n");
  let inFence = false;
  let mdFenceChar = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inFence) {
      const mdFenceMatch = MD_FENCE_RE.exec(line);

      if (mdFenceMatch) {
        inFence = true;
        mdFenceChar = mdFenceMatch[1][0];
        continue;
      }

      if (ORG_FENCE_START_RE.test(line)) {
        inFence = true;
        mdFenceChar = null;
        continue;
      }
    } else {
      if (mdFenceChar) {
        const mdFenceMatch = MD_FENCE_RE.exec(line);
        if (mdFenceMatch && mdFenceMatch[1][0] === mdFenceChar) {
          inFence = false;
        }
      } else if (ORG_FENCE_END_RE.test(line)) {
        inFence = false;
      }

      continue;
    }

    let closeIndex = null;

    if (BARE_DELIMITER_RE.test(line)) {
      for (let j = i + 1; j < lines.length; j++) {
        if (isBlank(lines[j])) break;
        if (BARE_DELIMITER_RE.test(lines[j])) {
          closeIndex = j;
          break;
        }
      }
    } else if (SINGLE_LINE_DISPLAY_RE.test(line)) {
      closeIndex = i;
    }

    if (closeIndex === null) continue;

    if (!isBlank(lines[i - 1])) {
      lines[i - 1] = addHardBreakBefore(lines[i - 1], hardBreak);
    }

    if (!isBlank(lines[closeIndex + 1])) {
      if (!lines[closeIndex].endsWith(hardBreak)) {
        lines[closeIndex] =
          lines[closeIndex].replace(/[ \t]+$/, "") + hardBreak;
      }
      lines[closeIndex + 1] = addHardBreakAfter(lines[closeIndex + 1]);
    }

    i = closeIndex;
  }

  return lines.join("\n");
}

module.exports = loosenDisplayMath;
