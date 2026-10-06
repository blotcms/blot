// Summarises what the request-time folder-link rewrite (app/blog/render/
// replaceFolderLinks) still does in production, from the two log lines that
// instrument it:
//
//   [folder-links]       one per html/css request where the pass rewrote a
//                        link or hit a missing file (app/blog/render/
//                        middleware.js, format documented in
//                        replaceFolderLinks/stats.js)
//   [folder-asset-origin] one per blog-folder file served to a request whose
//                        Referer is one of the blog's own hosts, i.e. a link
//                        on the blog's pages pointing at the origin rather
//                        than the CDN (app/blog/routes/assets.js)
//
// Dependency-free: reads log text on stdin, so it runs locally on piped
// output or on the production host. Run it from the repo root (or anywhere,
// by path). One container:
//
//   ssh blot "docker logs --since 24h blot-container-blue 2>&1" \
//     | node scripts/folder-links/analyze-logs.js
//
// All three containers (the same loop the node-response-time-review skill
// uses to collect app logs):
//
//   for c in blue green yellow; do
//     ssh blot "docker logs --since 24h blot-container-$c 2>&1"
//   done | node scripts/folder-links/analyze-logs.js --top 30
//
// Flags: --top N (rows per table, default 10), --json (machine-readable).
//
// Containers only keep logs back to their last deploy/restart, so --since
// can't reach further back than that.

const REWRITE_MARKER = "[folder-links] ";
const ORIGIN_MARKER = "[folder-asset-origin] ";

function parseFields(text) {
  const fields = {};
  for (const token of text.split(" ")) {
    const equals = token.indexOf("=");
    if (equals > 0) fields[token.slice(0, equals)] = token.slice(equals + 1);
  }
  return fields;
}

function parseCounts(text) {
  const counts = {};
  if (!text || text === "-") return counts;
  for (const item of text.split(",")) {
    const colon = item.lastIndexOf(":");
    if (colon > 0) counts[item.slice(0, colon)] = Number(item.slice(colon + 1)) || 0;
  }
  return counts;
}

// status:source:form:value (the value may itself contain colons)
function parseSamples(text) {
  if (!text || text === "-") return [];
  return text.split(",").map((item) => {
    const [status, source, form, ...rest] = item.split(":");
    return { status, source, form, value: safeDecode(rest.join(":")) };
  });
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}

// Returns null for any line that isn't one of ours.
function parseLine(line) {
  let index = line.indexOf(REWRITE_MARKER);
  if (index !== -1) {
    const fields = parseFields(line.slice(index + REWRITE_MARKER.length));
    if (!fields.blog || !fields.kind) return null;
    return {
      type: "rewrite",
      blog: fields.blog,
      handle: fields.handle || "",
      template: fields.template || "",
      view: fields.view || "",
      kind: fields.kind,
      rewrites: Number(fields.rewrites) || 0,
      enoent: Number(fields.enoent) || 0,
      ms: Number(fields.ms) || 0,
      sources: parseCounts(fields.sources),
      forms: parseCounts(fields.forms),
      samples: parseSamples(fields.sample),
    };
  }

  index = line.indexOf(ORIGIN_MARKER);
  if (index !== -1) {
    const fields = parseFields(line.slice(index + ORIGIN_MARKER.length));
    if (!fields.blog || !fields.path) return null;
    return {
      type: "origin",
      blog: fields.blog,
      handle: fields.handle || "",
      path: safeDecode(fields.path),
      refererPath: safeDecode(fields.referer_path || ""),
    };
  }

  return null;
}

function bump(map, key, n = 1) {
  map.set(key, (map.get(key) || 0) + n);
}

function top(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function aggregate(records, topN = 10) {
  const totals = { passes: 0, rewrites: 0, enoent: 0, ms: 0 };
  const kinds = new Map();
  const sources = new Map();
  const forms = new Map();
  const matrix = new Map(); // "source/form" -> n
  const blogs = new Map();
  const handles = new Map();
  const templates = new Map();
  const views = new Map();
  const samples = new Map(); // source -> Map(value -> n)
  const origin = { total: 0, blogs: new Map(), paths: new Map() };

  for (const record of records) {
    if (record.type === "origin") {
      origin.total++;
      handles.set(record.blog, record.handle);
      bump(origin.blogs, record.blog);
      bump(origin.paths, `${record.handle || record.blog}${record.path}`);
      continue;
    }

    totals.passes++;
    totals.rewrites += record.rewrites;
    totals.enoent += record.enoent;
    totals.ms += record.ms;
    handles.set(record.blog, record.handle);
    bump(kinds, record.kind, record.rewrites);
    if (record.rewrites) bump(blogs, record.blog, record.rewrites);
    bump(templates, record.template, record.rewrites);
    bump(views, `${record.template} ${record.view}`, record.rewrites);

    for (const [source, n] of Object.entries(record.sources)) bump(sources, source, n);
    for (const [form, n] of Object.entries(record.forms)) bump(forms, form, n);

    // The line only carries per-source and per-form totals, so the matrix is
    // exact only for the samples (up to 3 per request): label it as such.
    for (const sample of record.samples) {
      if (sample.status !== "ok") continue;
      bump(matrix, `${sample.source}/${sample.form}`);
      if (!samples.has(sample.source)) samples.set(sample.source, new Map());
      bump(samples.get(sample.source), sample.value);
    }
  }

  const withHandle = (rows) =>
    rows.map(([blog, n]) => ({ blog, handle: handles.get(blog) || "", n }));

  return {
    totals,
    kinds: Object.fromEntries(kinds),
    sources: Object.fromEntries(sources),
    forms: Object.fromEntries(forms),
    sampleMatrix: Object.fromEntries(matrix),
    topBlogs: withHandle(top(blogs, topN)),
    topTemplates: top(templates, topN).map(([template, n]) => ({ template, n })),
    topViews: top(views, topN).map(([view, n]) => ({ view, n })),
    topSamples: Object.fromEntries(
      [...samples.entries()].map(([source, values]) => [
        source,
        top(values, topN).map(([value, n]) => ({ value, n })),
      ])
    ),
    assetOrigin: {
      total: origin.total,
      topBlogs: withHandle(top(origin.blogs, topN)),
      topPaths: top(origin.paths, topN).map(([path, n]) => ({ path, n })),
    },
  };
}

function table(title, rows) {
  const lines = [`\n${title}`];
  if (!rows.length) lines.push("  (none)");
  for (const [count, label] of rows) {
    lines.push(`  ${String(count).padStart(8)}  ${label}`);
  }
  return lines.join("\n");
}

function counts(object) {
  return Object.entries(object)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => [n, name]);
}

function format(report) {
  const { totals } = report;
  const out = [
    "[folder-links] passes that rewrote or missed a link",
    `  passes logged: ${totals.passes}`,
    `  rewrites:      ${totals.rewrites}`,
    `  enoent:        ${totals.enoent}`,
    `  total ms:      ${totals.ms}`,
    table("Rewrites by kind", counts(report.kinds)),
    table("Rewrites by source", counts(report.sources)),
    table("Rewrites by form (relative links would break without the pass)", counts(report.forms)),
    table(
      "Source / form (from sampled links only, up to 3 per request)",
      counts(report.sampleMatrix)
    ),
    table(
      "Top blogs by rewrites",
      report.topBlogs.map((b) => [b.n, `${b.handle || "?"} (${b.blog})`])
    ),
    table(
      "Top templates by rewrites",
      report.topTemplates.map((t) => [t.n, t.template])
    ),
    table(
      "Top views by rewrites",
      report.topViews.map((v) => [v.n, v.view])
    ),
  ];

  for (const [source, values] of Object.entries(report.topSamples)) {
    out.push(
      table(
        `Top sampled values, source=${source}`,
        values.map((v) => [v.n, v.value])
      )
    );
  }

  out.push(
    "\n[folder-asset-origin] folder files fetched from the blog's own pages",
    `  total: ${report.assetOrigin.total}`,
    table(
      "Top blogs",
      report.assetOrigin.topBlogs.map((b) => [b.n, `${b.handle || "?"} (${b.blog})`])
    ),
    table(
      "Top paths",
      report.assetOrigin.topPaths.map((p) => [p.n, p.path])
    )
  );

  return out.join("\n") + "\n";
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const topIndex = args.indexOf("--top");
  const topN = topIndex === -1 ? 10 : Number(args[topIndex + 1]) || 10;

  const readline = require("readline");
  const records = [];
  readline
    .createInterface({ input: process.stdin, crlfDelay: Infinity })
    .on("line", (line) => {
      const record = parseLine(line);
      if (record) records.push(record);
    })
    .on("close", () => {
      const report = aggregate(records, topN);
      process.stdout.write(
        json ? JSON.stringify(report, null, 2) + "\n" : format(report)
      );
    });
}

main();
