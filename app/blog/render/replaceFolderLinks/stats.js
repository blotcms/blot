const { isReservedStaticPath } = require("../../lib/staticPaths");

// Instrumentation for the request-time folder-link rewrite (html.js, css.js).
// The passes take an optional stats object from createStats() and record each
// link they rewrite, or fail to find, on it; they never read it back, so the
// rewritten output is identical with or without one. middleware.js then calls
// summarize() and formatLine() once per request.

const SAMPLE_COUNT = 3;
const SAMPLE_LENGTH = 120;

function createStats(kind) {
  return {
    kind,
    // false when the pass exited early because nothing in the output could
    // need rewriting
    parsed: false,
    // [{ original, form }]
    rewrites: [],
    enoent: [],
  };
}

// original: the raw attribute / url() value. value: what was handed to
// lookupFile (original with any own-host prefix removed).
function record(stats, original, value, enoent) {
  const event = { original, form: classifyForm(original, value) };
  (enoent ? stats.enoent : stats.rewrites).push(event);
}

// static: a reserved global static path (/fonts, /icons...). host: an
// absolute URL on one of the blog's own hosts. root: starts with a slash.
// relative: neither, which a browser resolves against the page's URL - these
// would break if the pass were removed.
function classifyForm(original, value) {
  const path = value.split("#")[0].split("?")[0];
  if (isReservedStaticPath(path)) return "static";
  if (original !== value) return "host";
  if (original.startsWith("/")) return "root";
  return "relative";
}

function contains(haystack, needle) {
  return (
    typeof haystack === "string" &&
    (haystack.includes(needle) ||
      // attribute values are entity-encoded in the source they came from
      (needle.includes("&") && haystack.includes(needle.replace(/&/g, "&amp;"))))
  );
}

// Entry fields a template can render as markup. Listing retrievers drop
// fields the view doesn't reference (projectEntryFields), so a page that
// renders {{{body}}} may carry no html at all.
const MARKUP_FIELDS = ["html", "body", "teaser", "teaserBody"];

// Bounds the walk below on pathological locals.
const MAX_DEPTH = 6;
const MAX_NODES = 5000;

function isEntryLike(value) {
  return (
    MARKUP_FIELDS.some((field) => typeof value[field] === "string") ||
    (value.metadata !== null && typeof value.metadata === "object")
  );
}

// The entries a template could have interpolated into its output. Walks all
// render locals rather than naming them, since entries turn up under many
// (entry, entries, posts, recent_entries, all_entries, latest_entry, tagged,
// archives[].months[].entries...). Partials are skipped: they're template
// source, checked separately.
function candidateEntries(locals) {
  const entries = [];
  const seen = new Set();
  const stack = Object.keys(locals)
    .filter((name) => name !== "partials")
    .map((name) => [locals[name], 0]);

  while (stack.length && seen.size < MAX_NODES) {
    const [value, depth] = stack.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);

    if (!Array.isArray(value) && isEntryLike(value)) {
      entries.push(value);
      continue;
    }

    if (depth >= MAX_DEPTH) continue;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      stack.push([child, depth + 1]);
    }
  }

  return entries;
}

// Where did this link come from? Looks for the raw value in the template
// source (view + partials), then in entry markup, then in entry metadata.
// Only run for links that were rewritten or not found, never for every
// attribute on the page.
function classifySource(original, { view, partials, locals }) {
  if (contains(view, original)) return "template";
  for (const name of Object.keys(partials || {})) {
    if (contains(partials[name], original)) return "template";
  }

  const entries = candidateEntries(locals || {});

  for (const entry of entries) {
    if (MARKUP_FIELDS.some((field) => contains(entry[field], original))) {
      return "entry";
    }
  }

  for (const entry of entries) {
    const metadata = entry.metadata;
    if (!metadata || typeof metadata !== "object") continue;
    for (const key of Object.keys(metadata)) {
      if (contains(metadata[key], original)) return "metadata";
    }
  }

  return "other";
}

function count(counts, name) {
  counts[name] = (counts[name] || 0) + 1;
}

// context: { blogID, ms, view, partials, locals }
function summarize(stats, context) {
  const sourceCache = new Map();
  const sourceOf = (original) => {
    if (!sourceCache.has(original)) {
      sourceCache.set(original, classifySource(original, context));
    }
    return sourceCache.get(original);
  };

  const summary = {
    blogID: context.blogID,
    kind: stats.kind,
    parsed: stats.parsed,
    ms: context.ms,
    rewrites: stats.rewrites.length,
    enoent: stats.enoent.length,
    sources: {},
    forms: {},
    sample: [],
  };

  for (const { original, form } of stats.rewrites) {
    count(summary.sources, sourceOf(original));
    count(summary.forms, form);
  }

  const events = stats.rewrites
    .map((event) => Object.assign({ status: "ok" }, event))
    .concat(stats.enoent.map((event) => Object.assign({ status: "enoent" }, event)));

  summary.sample = events.slice(0, SAMPLE_COUNT).map((event) => ({
    status: event.status,
    source: sourceOf(event.original),
    form: event.form,
    original: event.original,
  }));

  return summary;
}

function formatCounts(counts) {
  return (
    Object.keys(counts)
      .map((name) => `${name}:${counts[name]}`)
      .join(",") || "-"
  );
}

// Keeps a value to one space- and comma-free token.
function encodeToken(value) {
  return String(value).replace(/[\s,]/g, encodeURIComponent);
}

function formatSample({ status, source, form, original }) {
  return `${status}:${source}:${form}:${encodeToken(original.slice(0, SAMPLE_LENGTH))}`;
}

// One line per request that rewrote a link or hit a missing file, e.g.
//
//   [folder-links] blog=blog_abc handle=foo template=SITE:blog view=entries.html
//   kind=html rewrites=3 enoent=1 ms=4 sources=template:2,entry:1
//   forms=root:2,relative:1 sample=ok:template:root:/a.jpg,enoent:entry:relative:b.jpg
//
// (all on one line). Every field is key=value with no spaces in the value;
// counts are name:n lists; each sample is status:source:form:value, where
// status is ok (rewritten) or enoent (no such file), and the value is
// truncated and has whitespace and commas percent-encoded.
// scripts/folder-links/analyze-logs.js parses this format.
function formatLine(summary, { handle, templateID, view }) {
  return [
    "[folder-links]",
    `blog=${summary.blogID}`,
    `handle=${encodeToken(handle)}`,
    `template=${encodeToken(templateID)}`,
    `view=${encodeToken(view)}`,
    `kind=${summary.kind}`,
    `rewrites=${summary.rewrites}`,
    `enoent=${summary.enoent}`,
    `ms=${Math.round(summary.ms)}`,
    `sources=${formatCounts(summary.sources)}`,
    `forms=${formatCounts(summary.forms)}`,
    `sample=${summary.sample.map(formatSample).join(",") || "-"}`,
  ].join(" ");
}

module.exports = {
  createStats,
  record,
  classifyForm,
  classifySource,
  summarize,
  formatLine,
};
