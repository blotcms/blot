// Renders a Google Doc from the Docs API's JSON (docs.documents.get with
// includeTabsContent) to HTML (#2975). The client stores that JSON as the
// .gdoc file, with each image's contentUri swapped for the path Blot keeps
// it at (imageProperties.blotSrc), see clients/google-drive/util/fetchDoc.js.
//
// The JSON says exactly what the writer did, so nothing is guessed from CSS
// as the HTML export needs: list nesting, checklists, code blocks, combined
// styles, header rows, tabs. Comments aren't in it at all.
//
// render(doc) resolves to { html, metadata }: metadata from the leading
// paragraphs, read with build/metadata as for every other format.
const Metadata = require("build/metadata");

const MONOSPACE =
  /^(courier|courier new|consolas|roboto mono|source code pro|inconsolata|menlo|monaco|fira code|fira mono|jetbrains mono|ibm plex mono|ubuntu mono|space mono|pt mono|andale mono|lucida console|monospace)$/i;

// Google marks the first and last line of a code block (Insert, Building
// blocks, Code block) with this private-use character
const CODE_BLOCK_MARK = String.fromCharCode(0xe907);

// A line break inside a paragraph (Shift+Enter) is a vertical tab
const LINE_BREAK = String.fromCharCode(11);

const ORDERED = /^(DECIMAL|ZERO_DECIMAL|UPPER_ALPHA|ALPHA|UPPER_ROMAN|ROMAN)$/;
const OL_TYPES = { UPPER_ALPHA: "A", ALPHA: "a", UPPER_ROMAN: "I", ROMAN: "i" };

const escape = (text) =>
  String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const pt = (dimension) => (dimension && dimension.magnitude) || 0;

// A heading's id, as a slug of its text, unique within the post
function slugger() {
  const used = new Set();
  return (text) => {
    const base =
      String(text)
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-") || "section";
    // Every id handed out is reserved, so "Intro", "Intro", "Intro 1"
    // can't give "intro-1" twice
    let id = base;
    for (let n = 1; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return id;
  };
}

const paragraphText = (paragraph) =>
  (paragraph.elements || [])
    .map((e) => (e.textRun ? e.textRun.content : ""))
    .join("")
    .replace(/\n$/, "");

const isEmptyParagraph = (paragraph) =>
  !(paragraph.elements || []).some(
    (e) =>
      (e.textRun && e.textRun.content.replace(/[\n\s]/g, "") !== "") ||
      e.inlineObjectElement ||
      e.horizontalRule ||
      e.footnoteReference ||
      e.person ||
      e.richLink ||
      e.dateElement
  );

function render(doc) {
  const tabs = doc.tabs || [{ documentTab: doc }];
  const context = {
    slug: slugger(),
    // headingId (Google's, for internal links) -> the slug it was given
    headings: new Map(),
    footnotes: [],
    footnoteNumbers: new Map(),
  };

  // Headings first, so a link to a heading later in the Doc resolves
  const collect = (tab) => {
    for (const el of tab.documentTab.body.content || []) {
      const p = el.paragraph;
      if (p && p.paragraphStyle && p.paragraphStyle.headingId)
        context.headings.set(
          p.paragraphStyle.headingId,
          context.slug(paragraphText(p))
        );
    }
    (tab.childTabs || []).forEach(collect);
  };
  tabs.forEach(collect);

  // Metadata from the first tab's leading paragraphs, before rendering
  const first = tabs[0].documentTab.body.content || [];
  const metadata = readMetadata(first);

  const wrap = tabs.length > 1 || tabs.some((t) => (t.childTabs || []).length);
  const renderTab = (tab) => {
    const inner = renderContent(
      tab.documentTab.body.content || [],
      tab.documentTab,
      context
    );
    const children = (tab.childTabs || []).map(renderTab).join("");
    if (!wrap) return inner + children;
    const title = (tab.tabProperties && tab.tabProperties.title) || "";
    return `<section class="tab" data-title="${escape(title)}" id="${escape(context.slug(title || "tab"))}">\n${inner}${children}</section>\n`;
  };

  let html = tabs.map(renderTab).join("");

  if (context.footnotes.length) {
    html +=
      '<section id="footnotes" class="footnotes footnotes-end-of-document" role="doc-endnotes"><hr>\n<ol>' +
      context.footnotes
        .map(
          ({ number, html: text }) =>
            `<li id="footnote-${number}"><p>${text}<a href="#ref-${number}" role="doc-backlink" class="footnote-back">↩︎</a></p>\n</li>\n`
        )
        .join("") +
      "</ol>\n</section>\n";
  }

  return { html: html.trim(), metadata };
}

// Leading paragraphs that are metadata lines ("Key: value", or YAML between
// --- lines) are taken out of the body, as for Markdown and the HTML export
function readMetadata(content) {
  const metadata = {};
  let i = 0;
  while (i < content.length && !content[i].paragraph) i++;

  // As the HTML converter did: headings (Title, Heading 1...) are never
  // metadata and don't end it, so "Title" then "Tags: a, b" still works
  const paragraphs = [];
  for (let j = i; j < content.length && content[j].paragraph; j++) {
    const named =
      (content[j].paragraph.paragraphStyle || {}).namedStyleType ||
      "NORMAL_TEXT";
    if (named === "NORMAL_TEXT" && !content[j].paragraph.bullet)
      paragraphs.push(j);
  }

  let fenced = false;
  let taken = 0;
  for (const j of paragraphs) {
    const text = paragraphText(content[j].paragraph).trim();
    if (!taken && (text === "---" || text === "—")) {
      fenced = true;
      taken += 1;
      continue;
    }
    if (
      fenced &&
      (text === "---" || text === "—") &&
      Object.keys(metadata).length
    ) {
      taken += 1;
      break;
    }
    if (!text) {
      // An image (or a rule, a chip) has no text but isn't a blank line
      if (!isEmptyParagraph(content[j].paragraph)) break;
      if (!Object.keys(metadata).length) break;
      taken += 1;
      break;
    }
    // Lines joined with Shift+Enter are each a metadata line, and all of
    // them have to be for the paragraph to be taken
    const found = {};
    const lines = text.split(LINE_BREAK).map((line) => line.trim());
    const isMetadata = lines.every((line) => {
      const colon = line.indexOf(":");
      if (colon === -1 || /\s/.test(line.slice(0, colon).trim())) return false;
      const parsed = Metadata(line);
      if (parsed.html === line) return false;
      Object.assign(found, parsed.metadata);
      return true;
    });
    if (!isMetadata) break;
    Object.assign(metadata, found);
    taken += 1;
  }

  if (!Object.keys(metadata).length) return {};
  // Mark the paragraphs taken, so renderContent skips them
  for (let k = 0; k < taken; k++) content[paragraphs[k]].blotMetadata = true;
  return metadata;
}

// The effective space below and above a paragraph, falling back to its
// named style's
function spacing(paragraph, tab) {
  const style = paragraph.paragraphStyle || {};
  const named = ((tab.namedStyles || {}).styles || []).find(
    (s) => s.namedStyleType === (style.namedStyleType || "NORMAL_TEXT")
  );
  const base = (named && named.paragraphStyle) || {};
  return {
    above: style.spaceAbove ? pt(style.spaceAbove) : pt(base.spaceAbove),
    below: style.spaceBelow ? pt(style.spaceBelow) : pt(base.spaceBelow),
  };
}

function renderContent(content, tab, context) {
  let html = "";
  // Normal paragraphs with no space between them, joined with <br> as one
  let lines = [];
  let previous = null;
  let list = null;
  let code = null;

  // Empty paragraphs since the last element: past the first, each is a
  // <br>, as the HTML converter keeps them (linebreaks.js)
  let empty = 0;
  // A display equation typed as "$$", the TeX, "$$" on paragraphs of their
  // own: kept as one paragraph of lines for restore-display-math.js
  let math = null;

  const flushLines = () => {
    if (lines.length) html += `<p>${lines.join("<br>\n")}</p>\n`;
    lines = [];
    // Never closed: just paragraphs
    if (math) html += math.map((line) => `<p>${line}</p>\n`).join("");
    math = null;
  };
  const flushList = () => {
    if (list) html += renderList(list, tab, context);
    list = null;
  };

  const codeHtml = (lines) =>
    `<pre><code>${escape(lines.join("\n").split(LINE_BREAK).join("\n"))}</code></pre>\n`;

  // Code blocks: the paragraphs from one carrying the mark to the next. A
  // mark with no partner (a line copied out of a block) is just dropped.
  const marks = content
    .map((el, i) =>
      el.paragraph && paragraphText(el.paragraph).includes(CODE_BLOCK_MARK)
        ? i
        : -1
    )
    .filter((i) => i !== -1);
  const opens = new Set();
  const closes = new Set();
  const single = new Set();
  for (let k = 0; k < marks.length; k++) {
    const text = paragraphText(content[marks[k]].paragraph);
    if (text.split(CODE_BLOCK_MARK).length > 2) single.add(marks[k]);
    else if (k + 1 < marks.length && !single.has(marks[k + 1])) {
      const next = paragraphText(content[marks[k + 1]].paragraph);
      if (next.split(CODE_BLOCK_MARK).length > 2) continue;
      opens.add(marks[k]);
      closes.add(marks[k + 1]);
      k++;
    }
  }
  const stripMark = (text) => text.split(CODE_BLOCK_MARK).join("");

  content.forEach((el, index) => {
    if (el.blotMetadata) return;

    const p = el.paragraph;
    const style = (p && p.paragraphStyle) || {};
    const named = style.namedStyleType || "NORMAL_TEXT";
    const heading = headingLevel(named);

    if (single.has(index)) {
      flushLines();
      flushList();
      html += codeHtml([stripMark(paragraphText(p))]);
      previous = null;
      return;
    }
    if (opens.has(index)) {
      flushLines();
      flushList();
      const text = stripMark(paragraphText(p));
      code = text ? [text] : [];
      previous = null;
      return;
    }
    if (closes.has(index)) {
      const text = stripMark(paragraphText(p));
      if (text) code.push(text);
      html += codeHtml(code);
      code = null;
      previous = null;
      return;
    }
    if (code) {
      if (p) code.push(stripMark(paragraphText(p)));
      return;
    }
    renderElement(el, p, style, heading);
  });

  function renderElement(el, p, style, heading) {
    // Blank lines count only between paragraphs
    if (!p || p.bullet || heading) empty = 0;
    if (el.table) {
      flushLines();
      flushList();
      html += renderTable(el.table, tab, context);
      previous = null;
      return;
    }

    if (el.tableOfContents) {
      flushLines();
      flushList();
      html += renderContent(el.tableOfContents.content || [], tab, context);
      previous = null;
      return;
    }

    if (!p) return;

    // Consecutive list items make one tree, even across list ids: Docs
    // imported from Word give each nesting level its own list
    if (p.bullet) {
      flushLines();
      // ...but a top-level item of another list starts a new one (a
      // numbered list straight after a bulleted one)
      const top = !p.bullet.nestingLevel;
      if (list && top && list.rootId && list.rootId !== p.bullet.listId)
        flushList();
      if (!list) list = { items: [], rootId: null };
      if (top && !list.rootId) list.rootId = p.bullet.listId;
      list.items.push(p);
      previous = null;
      return;
    }
    flushList();

    if (heading) {
      flushLines();
      const inner = renderInline(p, tab, context);
      if (inner.trim()) {
        const slug = style.headingId && context.headings.get(style.headingId);
        html += `<h${heading}${slug ? ` id="${slug}"` : ""}>${inner}</h${heading}>\n`;
      }
      previous = null;
      return;
    }

    if (isEmptyParagraph(p)) {
      if (math) return;
      flushLines();
      empty += 1;
      previous = null;
      return;
    }
    const blank = empty;
    empty = 0;

    const text = paragraphText(p).trim();
    if (text === "$$" || math) {
      if (!math) {
        flushLines();
        math = [];
      }
      math.push(escape(paragraphText(p)));
      if (text === "$$" && math.length > 1) {
        html += `<p>${math.join("<br>\n")}</p>\n`;
        math = null;
      }
      previous = null;
      return;
    }

    // Alone on its line: a rule, not text
    if (
      p.elements.length &&
      p.elements.every(
        (e) => e.horizontalRule || (e.textRun && !e.textRun.content.trim())
      )
    ) {
      flushLines();
      html += "<hr>\n";
      previous = null;
      return;
    }

    const gap =
      previous &&
      (spacing(previous, tab).below > 0 || spacing(p, tab).above > 0);
    if (gap) flushLines();
    if (!lines.length && blank > 1 && html && !html.endsWith("<hr>\n"))
      html += "<br>\n".repeat(blank - 1);
    lines.push(renderInline(p, tab, context));
    previous = p;
  }

  flushLines();
  flushList();
  return html;
}

// TITLE -> 1, SUBTITLE -> 2, HEADING_n -> n, anything else -> undefined
function headingLevel(named = "NORMAL_TEXT") {
  if (named === "TITLE") return 1;
  if (named === "SUBTITLE") return 2;
  return (named.match(/^HEADING_(\d)$/) || [])[1];
}

function listKind(tab, listId, level) {
  const lists = tab.lists || {};
  const nesting =
    (((lists[listId] || {}).listProperties || {}).nestingLevels || [])[level] ||
    {};
  if (nesting.glyphSymbol) return { tag: "ul" };
  if (ORDERED.test(nesting.glyphType || ""))
    return {
      tag: "ol",
      type: OL_TYPES[nesting.glyphType],
      startNumber: nesting.startNumber,
    };
  // Docs' checklists have no glyph but do have a format. A list with
  // neither (seen in Docs imported from elsewhere) is a plain list.
  if (
    nesting.glyphType === "GLYPH_TYPE_UNSPECIFIED" &&
    nesting.glyphFormat !== undefined
  )
    return { tag: "ul", checklist: true };
  return { tag: "ul" };
}

function renderList({ items }, tab, context) {
  // Build the tree from each item's nesting level
  const root = { children: [] };
  const stack = [{ level: -1, node: root }];
  for (const p of items) {
    const level = p.bullet.nestingLevel || 0;
    while (stack.length > 1 && stack[stack.length - 1].level >= level)
      stack.pop();
    const node = { p, children: [] };
    stack[stack.length - 1].node.children.push(node);
    stack.push({ level, node });
  }

  // Docs numbers a list on across anything in between, by list and level
  context.counters = context.counters || new Map();

  const renderLevel = (children, level) => {
    const listId = children[0].p.bullet.listId;
    const kind = listKind(tab, listId, level);
    const key = `${listId}:${level}`;
    const start = context.counters.has(key)
      ? context.counters.get(key) + 1
      : kind.startNumber || 1;
    context.counters.set(key, start - 1 + children.length);
    let attrs = "";
    if (kind.tag === "ol" && start > 1) attrs += ` start="${start}"`;
    if (kind.type) attrs += ` type="${kind.type}"`;
    if (kind.checklist) attrs += ' class="checklist"';
    const lis = children
      .map(({ p, children: sub }) => {
        // Docs numbers a sub-list from 1 again under each item
        for (const k of [...context.counters.keys()])
          if (Number(k.split(":").pop()) > level) context.counters.delete(k);
        let inner = renderInline(p, tab, context, {
          checklist: kind.checklist,
        });
        if (kind.checklist) {
          const checked = isStruckThrough(p);
          inner = `<input type="checkbox" disabled${checked ? " checked" : ""}> ${checked ? renderInline(p, tab, context, { noStrike: true }) : inner}`;
        }
        // A numbered heading: the heading inside its item, as the HTML
        // export gave it
        const style = p.paragraphStyle || {};
        const h = headingLevel(style.namedStyleType);
        if (h) {
          const slug = style.headingId && context.headings.get(style.headingId);
          inner = `<h${h}${slug ? ` id="${slug}"` : ""}>${inner}</h${h}>`;
        }
        // A deeper level after an item nests inside it
        return `<li>${inner}${sub.length ? "\n" + renderLevel(sub, sub[0].p.bullet.nestingLevel || 0) : ""}</li>\n`;
      })
      .join("");
    return `<${kind.tag}${attrs}>\n${lis}</${kind.tag}>\n`;
  };

  // Items deeper than the first item's level with no parent still render
  return renderLevel(
    root.children,
    root.children.length ? root.children[0].p.bullet.nestingLevel || 0 : 0
  );
}

const isMonospace = (p) => {
  // Line breaks and spaces often keep the body font: only text counts
  const runs = (p.elements || []).filter(
    (e) => e.textRun && e.textRun.content.trim()
  );
  return (
    runs.length > 0 &&
    !(p.elements || []).some((e) => !e.textRun) &&
    runs.every((e) =>
      MONOSPACE.test(
        ((e.textRun.textStyle || {}).weightedFontFamily || {}).fontFamily || ""
      )
    )
  );
};

const isStruckThrough = (p) => {
  const runs = (p.elements || []).filter(
    (e) => e.textRun && e.textRun.content.trim()
  );
  return (
    runs.length > 0 &&
    runs.every((e) => (e.textRun.textStyle || {}).strikethrough)
  );
};

function renderTable(table, tab, context) {
  const rows = table.tableRows || [];

  const cellText = (cell) =>
    (cell.content || [])
      .filter((c) => c.paragraph)
      .map((c) => paragraphText(c.paragraph))
      .join("\n")
      .split(LINE_BREAK)
      .join("\n");

  // Code tables, as Blot has always read them: a 1x1 table is a code block,
  // and a 2x1 one is a language and a code block
  if (rows.length === 1 && rows[0].tableCells.length === 1)
    return `<pre><code>${escape(cellText(rows[0].tableCells[0]))}</code></pre>\n`;
  if (rows.length === 2 && rows.every((r) => r.tableCells.length === 1)) {
    const language = cellText(rows[0].tableCells[0]).trim();
    return `<pre${language ? ` class="${escape(language)}"` : ""}><code>${escape(cellText(rows[1].tableCells[0]))}</code></pre>\n`;
  }

  let head = "";
  let body = "";
  // Google keeps a cell for every column, those a merge covers included
  // (with nothing in them): skip those, by position
  const covered = new Set();
  rows.forEach((row, r) => {
    const header = row.tableRowStyle && row.tableRowStyle.tableHeader;
    const positional = row.tableCells.length === table.columns;
    const cells = row.tableCells
      .map((cell, c) => {
        if (positional && covered.has(`${r}:${c}`)) return "";
        const { columnSpan = 1, rowSpan = 1 } = cell.tableCellStyle || {};
        if (positional)
          for (let i = 0; i < rowSpan; i++)
            for (let j = 0; j < columnSpan; j++)
              if (i || j) covered.add(`${r + i}:${c + j}`);
        const tag = header ? "th" : "td";
        const style = cell.tableCellStyle || {};
        let attrs = "";
        if (style.columnSpan > 1) attrs += ` colspan="${style.columnSpan}"`;
        if (style.rowSpan > 1) attrs += ` rowspan="${style.rowSpan}"`;
        const firstParagraph = (cell.content || []).find((c) => c.paragraph);
        const alignment =
          firstParagraph &&
          (firstParagraph.paragraph.paragraphStyle || {}).alignment;
        if (alignment === "CENTER") attrs += ' style="text-align:center"';
        if (alignment === "END") attrs += ' style="text-align:right"';
        let inner = renderContent(cell.content || [], tab, context).trim();
        // A cell of one paragraph needs no <p>
        const single = inner.match(/^<p>([\s\S]*)<\/p>$/);
        if (single && !single[1].includes("<p>")) inner = single[1];
        return `<${tag}${attrs}>${inner}</${tag}>`;
      })
      .filter(Boolean)
      .join("\n");
    if (header) head += `<tr>\n${cells}\n</tr>\n`;
    else body += `<tr>\n${cells}\n</tr>\n`;
  });

  return `<table>\n${head ? `<thead>\n${head}</thead>\n` : ""}<tbody>\n${body}</tbody>\n</table>\n`;
}

// The paragraph's elements as inline HTML, consecutive runs with the same
// styles merged so tags aren't repeated at every run boundary
function renderInline(p, tab, context, options = {}) {
  const parts = [];
  // Bold and italic set on the paragraph's style (a Heading 1 styled
  // italic, say) apply to every run that doesn't say otherwise, as the HTML
  // export gave them. Not underline: on a heading it reads as a link.
  const named = ((tab.namedStyles || {}).styles || []).find(
    (s) =>
      s.namedStyleType ===
      ((p.paragraphStyle || {}).namedStyleType || "NORMAL_TEXT")
  );
  const base = {};
  for (const key of ["bold", "italic"])
    if (named && named.textStyle && named.textStyle[key]) base[key] = true;
  // A paragraph wholly in a typewriter font is writing in that font, as
  // often as it is code, so only monospace words among others become code.
  // Code blocks come from Google's own code blocks and 1x1 tables.
  options = { ...options, plainFont: isMonospace(p) };

  for (const e of p.elements || []) {
    if (e.textRun) {
      let text = e.textRun.content;
      if (!text) continue;
      text = text.replace(/\n$/, "");
      if (!text) continue;
      parts.push({ style: { ...base, ...(e.textRun.textStyle || {}) }, text });
    } else if (e.inlineObjectElement) {
      parts.push({
        raw: renderImage(e.inlineObjectElement.inlineObjectId, tab),
      });
    } else if (e.footnoteReference) {
      parts.push({ raw: renderFootnoteRef(e.footnoteReference, tab, context) });
    } else if (e.horizontalRule) {
      parts.push({ raw: "<hr>" });
    } else if (e.person) {
      const props = e.person.personProperties || {};
      const name = escape(props.name || props.email || "");
      parts.push({
        raw: props.email
          ? `<a href="mailto:${escape(props.email)}">${name}</a>`
          : name,
      });
    } else if (e.richLink) {
      const props = e.richLink.richLinkProperties || {};
      parts.push({
        raw: `<a href="${escape(props.uri || "")}">${escape(props.title || props.uri || "")}</a>`,
      });
    } else if (e.dateElement) {
      const props = e.dateElement.dateElementProperties || {};
      parts.push({ raw: escape(props.displayText || props.timestamp || "") });
    }
  }

  // Group runs by link first, then by style
  let html = "";
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (part.raw !== undefined) {
      html += part.raw;
      i++;
      continue;
    }
    const href = linkOf(part.style, context);
    let j = i;
    let inner = "";
    while (
      j < parts.length &&
      parts[j].raw === undefined &&
      linkOf(parts[j].style, context) === href
    ) {
      inner += styled(parts[j], options, Boolean(href));
      j++;
    }
    html += href ? `<a href="${escape(href)}">${inner}</a>` : inner;
    i = j;
  }

  return mergeAdjacent(html);
}

function linkOf(style, context) {
  const link = style.link;
  if (!link) return null;
  if (link.url)
    return /^\s*(javascript|data|vbscript):/i.test(link.url) ? null : link.url;
  // With includeTabsContent Google gives link.heading { id, tabId }; the
  // older headingId is kept for Docs fetched without it
  const headingId = (link.heading && link.heading.id) || link.headingId;
  if (headingId && context.headings.has(headingId))
    return "#" + context.headings.get(headingId);
  // Bookmarks have no position in the JSON, so nothing to link to
  return null;
}

function styled({ style, text }, options, inLink) {
  let html = escape(text).split(LINE_BREAK).join("<br>\n");
  const font = (style.weightedFontFamily || {}).fontFamily || "";
  if (MONOSPACE.test(font) && !options.plainFont) html = `<code>${html}</code>`;
  if (style.baselineOffset === "SUPERSCRIPT") html = `<sup>${html}</sup>`;
  if (style.baselineOffset === "SUBSCRIPT") html = `<sub>${html}</sub>`;
  if (style.strikethrough && !options.noStrike) html = `<s>${html}</s>`;
  // Docs underlines links itself
  if (style.underline && !inLink) html = `<u>${html}</u>`;
  if (style.italic) html = `<em>${html}</em>`;
  if (style.bold) html = `<strong>${html}</strong>`;
  return html;
}

// <strong>a</strong><strong>b</strong> -> <strong>ab</strong>
function mergeAdjacent(html) {
  let previous;
  do {
    previous = html;
    html = html.replace(/<\/(strong|em|u|s|sup|sub|code)><\1>/g, "");
  } while (html !== previous);
  return html;
}

function renderImage(id, tab) {
  const object = ((tab.inlineObjects || {})[id] || {}).inlineObjectProperties;
  const embedded = object && object.embeddedObject;
  if (!embedded) return "";
  const src = embedded.imageProperties && embedded.imageProperties.blotSrc;
  if (!src) return "";
  // No width or height: the HTML export never gave them, and a template
  // with max-width:100% but no height:auto would squash the image
  let attrs = `src="${escape(src)}" alt="${escape(embedded.description || "")}"`;
  if (embedded.title) attrs += ` title="${escape(embedded.title)}"`;
  return `<img ${attrs}>`;
}

function renderFootnoteRef(ref, tab, context) {
  // Numbered here, not by Google, which numbers each tab from 1
  if (!context.footnoteNumbers.has(ref.footnoteId)) {
    const number = context.footnotes.length + 1;
    context.footnoteNumbers.set(ref.footnoteId, number);
    const footnote = (tab.footnotes || {})[ref.footnoteId];
    const text = footnote
      ? (footnote.content || [])
          .filter((c) => c.paragraph)
          .map((c) => renderInline(c.paragraph, tab, context).trim())
          .join("<br>\n")
      : "";
    context.footnotes.push({ number, html: text });
  }
  const number = context.footnoteNumbers.get(ref.footnoteId);
  return `<a href="#footnote-${number}" id="ref-${number}" role="doc-noteref" class="footnote-ref"><sup>${number}</sup></a>`;
}

module.exports = render;
module.exports.isDocJSON = (text) => {
  const start = text.trimStart();
  if (!start.startsWith("{")) return false;
  try {
    const doc = JSON.parse(start);
    return Boolean(
      doc && (doc.tabs || doc.body) && (doc.blotDoc || doc.documentId)
    );
  } catch (err) {
    return false;
  }
};
