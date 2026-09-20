#!/usr/bin/env node
// Compare rendered pane output with the real OS screenshots.
//
//   node app/helper/pane/qa/diff.js [--case ID] [--os X] [--theme X] [--view X]
//                                   [--json] [--explain] [--top N] [--threshold 0.1]
//
// Writes aligned reference/rendered/diff/heatmap PNGs to qa/out/<id>/ (git-ignored),
// prints a table (or JSON), and exits 1 if any case fails or has no rendering
// (2 on errors). Limits live in qa/thresholds.json.

const fs = require("fs");
const path = require("path");
const { loadCases } = require("./lib/cases");
const { parseArgs, selectCases } = require("./lib/args");
const { loadThresholds } = require("./lib/thresholds");
const { analyze, roundDeep } = require("./lib/run");
const { OUT_DIR } = require("./lib/cases");

function pad(text, width, right) {
  text = String(text);
  return right ? text.padStart(width) : text.padEnd(width);
}

function box(c) {
  return `${Math.round(c.x)},${Math.round(c.y)} ${Math.round(c.w)}x${Math.round(c.h)}`;
}

function table(entries) {
  const rows = entries.map((e) => {
    if (!e.diff) return [e.id, e.status.toUpperCase(), "-", "-", e.message || ""];
    const worst = e.clusters[0];
    return [
      e.id,
      e.status.toUpperCase(),
      e.diff.percent.toFixed(2) + "%",
      e.shadow.error.toFixed(1),
      worst ? `${box(worst)} (${worst.region || "?"})` : "-",
    ];
  });
  const head = ["case", "result", "diff", "shadow", "worst region (x,y WxH css px, from window top-left)"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((v, i) => pad(v, widths[i], i === 2 || i === 3)).join("  ");
  return [line(head), ...rows.map(line)].join("\n");
}

function explain(e, top) {
  const lines = [`${e.id}: ${e.status.toUpperCase()}`];
  if (!e.diff) {
    lines.push(`  ${e.message}`);
    return lines.join("\n");
  }
  const g = e.geometry;
  lines.push(
    `  window ${g.windowLogical.w}x${g.windowLogical.h} css px (rendered differs by ${g.sizeDelta.w}x${g.sizeDelta.h}); ` +
      `coordinates are css px from the window's top-left corner`
  );
  for (const f of e.failures || []) {
    lines.push(`  FAIL ${f.metric}${f.region ? " [" + f.region + "]" : ""}: ${f.value.toFixed(2)} > ${f.limit}`);
  }
  lines.push(
    `  rows: ${e.rows.referenceRows} reference / ${e.rows.renderedRows} rendered text rows, ` +
      `mean offset y ${(e.rows.meanYOffset / e.scale).toFixed(1)}px x ${(e.rows.meanXOffset / e.scale).toFixed(1)}px`
  );
  lines.push(
    `  shadow error ${e.shadow.error.toFixed(1)}` +
      (e.shadow.referenceHasShadow ? "" : " (reference has no shadow; rendering should not add one)")
  );
  for (const r of e.regions) {
    lines.push(`  region ${r.name} (${r.kind}): ${r.percent.toFixed(2)}% differ`);
  }
  lines.push(`  top ${Math.min(top, e.clusters.length)} of ${e.clusters.length} diff clusters:`);
  for (const c of e.clusters.slice(0, top)) {
    lines.push(
      `    #${c.rank} at ${box(c)}  in ${c.region || "?"}  area ${c.areaCss.toFixed(0)}px2  mean delta ${c.meanDelta.toFixed(0)}/255`
    );
  }
  lines.push(`  images: ${path.relative(process.cwd(), path.join(OUT_DIR, e.id))}/{reference,rendered,diff,heatmap}.png`);
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cases = selectCases(loadCases(), args);
  if (!cases.length) {
    console.error("No cases match.");
    process.exit(2);
  }
  const thresholds = loadThresholds();
  const threshold = args.threshold === undefined ? undefined : parseFloat(args.threshold);
  const entries = [];
  for (const c of cases) entries.push(await analyze(c, thresholds, { threshold }));

  const summary = {
    total: entries.length,
    pass: entries.filter((e) => e.status === "pass").length,
    fail: entries.filter((e) => e.status === "fail").length,
    missing: entries.filter((e) => e.status === "missing").length,
    error: entries.filter((e) => e.status === "error").length,
  };
  const report = roundDeep({ version: 1, summary, cases: entries });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "report.json"), JSON.stringify(report, null, 2) + "\n");

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    console.log(table(report.cases));
    console.log(
      `\n${summary.pass} pass, ${summary.fail} fail, ${summary.missing} missing, ${summary.error} error (of ${summary.total})`
    );
    if (args.explain) {
      const top = args.top ? parseInt(args.top, 10) : 8;
      console.log("");
      console.log(report.cases.map((e) => explain(e, top)).join("\n\n"));
    }
  }
  process.exit(summary.error ? 2 : summary.fail || summary.missing ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
