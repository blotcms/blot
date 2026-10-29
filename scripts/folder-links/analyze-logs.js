// Finds blog-folder files (and Blot's global static files) the app still
// serves from the origin instead of the CDN, from the [folder-asset] log line
// (app/blog/routes/assets.js): one per blog-folder file (not page) or global
// static file served, with how (served=origin, cdn-redirect or static) and the
// Referer, i.e. the page whose link reached the origin rather than the CDN.
// The older [folder-asset-origin] line (same-site referers only, always served
// from the origin) is still accepted.
//
// Dependency-free: reads log text on stdin, so it runs locally on piped
// output or on the production host. Run it from the repo root (or anywhere,
// by path). One container:
//
//   ssh blot "docker logs --since 24h blot-blue 2>&1" \
//     | node scripts/folder-links/analyze-logs.js
//
// Both units (the same loop the node-response-time-review skill
// uses to collect app logs):
//
//   for c in blue green; do
//     ssh blot "docker logs --since 24h blot-$c 2>&1"
//   done | node scripts/folder-links/analyze-logs.js --top 30
//
// Flags: --top N (rows per table, default 10), --json (machine-readable).
//
// Containers only keep logs back to their last deploy/restart, so --since
// can't reach further back than that.

const ASSET_MARKER = "[folder-asset] ";
const OLD_ASSET_MARKER = "[folder-asset-origin] ";

function parseFields(text) {
  const fields = {};
  for (const token of text.split(" ")) {
    const equals = token.indexOf("=");
    if (equals > 0) fields[token.slice(0, equals)] = token.slice(equals + 1);
  }
  return fields;
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
  // The request logger's response line quotes the request's slowest step,
  // which can be one of our lines cut to 80 characters: not a record.
  if (line.includes(' slowest=+')) return null;

  let index = line.indexOf(ASSET_MARKER);
  if (index !== -1) {
    const fields = parseFields(line.slice(index + ASSET_MARKER.length));
    if (!fields.blog || !fields.path) return null;
    return {
      blog: fields.blog,
      handle: fields.handle || "",
      served: fields.served || "origin",
      path: safeDecode(fields.path),
      referer: fields.referer && fields.referer !== "-" ? safeDecode(fields.referer) : "",
      sameSite: fields.same_site === "1",
    };
  }

  // Old format: only logged same-site referers, and only origin responses.
  index = line.indexOf(OLD_ASSET_MARKER);
  if (index !== -1) {
    const fields = parseFields(line.slice(index + OLD_ASSET_MARKER.length));
    if (!fields.blog || !fields.path) return null;
    const handle = fields.handle || "";
    return {
      blog: fields.blog,
      handle,
      served: "origin",
      path: safeDecode(fields.path),
      // no host in the old line: the blog's handle stands in for it
      referer: fields.referer_path
        ? `${handle || fields.blog}${safeDecode(fields.referer_path)}`
        : "",
      sameSite: true,
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
  const handles = new Map();
  const asset = {
    total: 0,
    served: new Map(),
    referers: new Map(), // same site / other site / none / invalid
    blogs: new Map(),
    paths: new Map(),
    pages: new Map(), // referer page -> n
    pageSamples: new Map(), // referer page -> most recent file path
  };

  for (const record of records) {
    asset.total++;
    handles.set(record.blog, record.handle);
    bump(asset.served, record.served);
    bump(
      asset.referers,
      record.referer === "invalid"
        ? "invalid referer"
        : !record.referer
        ? "no referer"
        : record.sameSite
        ? "same site"
        : "other site"
    );
    bump(asset.blogs, record.blog);
    bump(asset.paths, `${record.handle || record.blog}${record.path}`);
    if (record.referer && record.referer !== "invalid") {
      bump(asset.pages, record.referer);
      asset.pageSamples.set(record.referer, record.path);
    }
  }

  const withHandle = (rows) =>
    rows.map(([blog, n]) => ({ blog, handle: handles.get(blog) || "", n }));

  return {
    asset: {
      total: asset.total,
      served: Object.fromEntries(asset.served),
      referers: Object.fromEntries(asset.referers),
      topBlogs: withHandle(top(asset.blogs, topN)),
      topPaths: top(asset.paths, topN).map(([path, n]) => ({ path, n })),
      topReferers: top(asset.pages, topN).map(([page, n]) => ({
        page,
        n,
        samplePath: asset.pageSamples.get(page),
      })),
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
  const out = [
    "[folder-asset] folder and static files served by the app",
    `  total: ${report.asset.total}`,
    table("Served", counts(report.asset.served)),
    table("Referer (same site = one of the blog's own pages)", counts(report.asset.referers)),
    table(
      "Top blogs",
      report.asset.topBlogs.map((b) => [b.n, `${b.handle || "?"} (${b.blog})`])
    ),
    table(
      "Top paths",
      report.asset.topPaths.map((p) => [p.n, p.path])
    ),
    table(
      "Top referer pages (fetch the page and find the link to the file)",
      report.asset.topReferers.map((r) => [r.n, `${r.page}  ->  ${r.samplePath}`])
    ),
  ];

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
